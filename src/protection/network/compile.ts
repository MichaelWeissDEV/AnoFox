/**
 * Compiles Policy Engine state (profile levels + user rules) for the `network` and `scripts`
 * modules into declarativeNetRequest rules.
 *
 * Priority bands (higher wins; at equal priority DNR lets allow beat block):
 *   1 / 10   URL cleaner redirect / cleaner allows
 *   20       profile base blocks (network, scripts)
 *   5        per-site "pause adblock" (allowAllRequests): above list rules (1-3), below everything else
 *   21..32   user rules: 21 + (siteScope*3 + targetSpecificity)*2 + (block ? 1 : 0)
 *            -> mirrors the engine: site > global, target > no target, block > allow
 *   60 / 70  Social Embed Guard block / temporary embed allow (see dnr-manager)
 * User rules of module X therefore can never lift a block of a higher band (embed, future malware).
 */

import type { ModuleId, PolicyState, UserRule, Level } from '../../core/policy-engine/policy.ts';
import { effectiveLevels } from '../../core/policy-engine/policy.ts';

export const DNR_RULE_POLICY_BASE = 4000; // 4000..4009 profile blocks
export const DNR_RULE_POLICY_USER_BASE = 5000; // dynamic user rules
export const DNR_RULE_POLICY_SESSION_BASE = 6000; // session user rules (session / tab durations)
export const DNR_RULE_POLICY_SESSION_END = 6999;
export const PRIORITY_POLICY_BASE = 20;
export const PRIORITY_POLICY_USER_MIN = 21;
export const MAX_POLICY_USER_RULES = 900;
export const PRIORITY_ADBLOCK_PAUSE = 5;
export const DNR_RULE_POLICY_CSP_BASE = 4100; // 4100..4109 profile CSP rules

/**
 * CSP values (verified in Firefox 158, see test/firefox/csp):
 *  strict:   blocks inline scripts, event handlers, eval, Function, wasm compilation; external and
 *            cross-origin scripts, blob/data workers and dynamic imports keep working
 *  lockdown: blocks all script execution (also workers and plugins)
 * Appended (never `set`) so the site's own CSP is never weakened; multiple policies intersect.
 */
export const CSP_INLINE_STRICT = 'script-src * data: blob:';
export const CSP_INLINE_LOCKDOWN = "script-src 'none'; worker-src 'none'; object-src 'none'";

type RT = browser.declarativeNetRequest.ResourceType;
type DnrRule = browser.declarativeNetRequest.Rule;

const SCRIPT_TYPES: RT[] = ['script'];
// Everything except images, scripts (owned by the `scripts` module) and top-level navigation
const NETWORK_LOCKDOWN_TYPES: RT[] = [
  'sub_frame', 'stylesheet', 'font', 'media', 'xmlhttprequest', 'websocket', 'ping', 'object', 'other'
];
const NETWORK_STRICT_TYPES: RT[] = ['sub_frame', 'font'];

function typesFor(module: ModuleId): RT[] | null {
  if (module === 'scripts') return SCRIPT_TYPES;
  if (module === 'network') return [...NETWORK_LOCKDOWN_TYPES, 'image']; // explicit user rules may also cover images
  return null; // other modules are not DNR-enforced by this compiler
}

export function userRulePriority(rule: UserRule): number {
  const site = rule.scope.kind === 'site' ? 1 : 0;
  const target = rule.target === undefined ? 0 : 1; // exact-vs-parent cannot be expressed; see unsupported note
  return PRIORITY_POLICY_USER_MIN + (site * 3 + target) * 2 + (rule.effect === 'block' ? 1 : 0);
}

function baseBlocks(network: Level, scripts: Level, extensionHost?: string): DnrRule[] {
  const out: DnrRule[] = [];
  let id = DNR_RULE_POLICY_BASE;
  // Requests issued by AnoFox itself (list updates from the background, options/popup pages) must never be
  // subject to its own default-deny rules; found by the end-to-end suite (lockdown blocked the extension's fetch).
  const own: Partial<DnrRule['condition']> = extensionHost ? { excludedInitiatorDomains: [extensionHost] } : {};
  const add = (types: RT[]) => out.push({
    id: id++, priority: PRIORITY_POLICY_BASE, action: { type: 'block' },
    condition: { domainType: 'thirdParty', resourceTypes: types, ...own }
  });
  const addAll = (types: RT[]) => out.push({
    id: id++, priority: PRIORITY_POLICY_BASE, action: { type: 'block' },
    condition: { resourceTypes: types, ...own }
  });
  if (network === 'lockdown') add(NETWORK_LOCKDOWN_TYPES);
  else if (network === 'strict') add(NETWORK_STRICT_TYPES);
  if (scripts === 'lockdown') addAll(SCRIPT_TYPES);
  else if (scripts === 'strict') add(SCRIPT_TYPES);
  return out;
}

export interface CompiledPolicy {
  dynamic: DnrRule[];
  session: DnrRule[];
  /** Rules the DNR layer cannot enforce faithfully; the UI must show these as not enforced. */
  unsupported: Array<{ ruleId: string; reason: string }>;
}

function cspRule(id: number, value: string, priority: number, extra: DnrRule['condition']): DnrRule {
  return {
    id, priority,
    action: { type: 'modifyHeaders', responseHeaders: [{ header: 'content-security-policy', operation: 'append', value }] },
    condition: { resourceTypes: ['main_frame', 'sub_frame'], ...extra }
  } as DnrRule;
}

/**
 * Inline-script policy (module `inline`), compiled as ONE consistent set of CSP header rules.
 *
 * Deliberately no `allow` rules: an allow rule on main_frame/sub_frame of a site would also lift
 * unrelated blocks (network module, list rules) for that site. Exceptions are instead expressed by
 * excluding domains from the CSP rules, which can only ever remove the CSP header injection.
 *
 * Effective CSP for a document host (mirrors the engine precedence):
 *   any matching site rule: block (lockdown CSP) wins over allow (no CSP)
 *   else global rule: block wins over allow
 *   else the profile's level (strict / lockdown / none)
 * Rules act on the DOCUMENT host (requestDomains); `tab` and `once` durations cannot be expressed
 * (rules would have to differ per tab) and are reported as unsupported. `session` rules are compiled like
 * permanent ones; they vanish because the settings prune removes them at session end.
 */
function compileInline(
  state: PolicyState, level: Level, now: number, dynamic: DnrRule[], unsupported: CompiledPolicy['unsupported']
): void {
  if (level === 'off') return;
  const siteAllow = new Set<string>();
  const siteBlock = new Set<string>();
  let globalAllow = false;
  let globalBlock = false;
  for (const rule of state.rules) {
    if (rule.module !== 'inline') continue;
    if (rule.expiresAt !== undefined && rule.expiresAt <= now) continue;
    if (rule.target !== undefined || rule.cookieStoreId !== undefined || rule.duration === 'once' || rule.duration === 'tab') {
      unsupported.push({ ruleId: rule.id, reason: 'Für Inline-Skripte nicht erzwingbar: Ziel, Container, Einmal- oder Tab-Dauer (nur Website/global, Sitzung/dauerhaft)' });
      continue;
    }
    if (rule.scope.kind === 'site') (rule.effect === 'allow' ? siteAllow : siteBlock).add(rule.scope.site);
    else if (rule.effect === 'allow') globalAllow = true;
    else globalBlock = true;
  }
  const profileBase = level === 'lockdown' ? CSP_INLINE_LOCKDOWN : level === 'strict' ? CSP_INLINE_STRICT : null;
  const base = globalBlock ? CSP_INLINE_LOCKDOWN : globalAllow ? null : profileBase;
  const siteDomains = Array.from(new Set([...siteAllow, ...siteBlock]));
  if (base) {
    dynamic.push(cspRule(DNR_RULE_POLICY_CSP_BASE, base, PRIORITY_POLICY_BASE,
      siteDomains.length ? { excludedRequestDomains: siteDomains } : {}));
  }
  if (siteBlock.size > 0) {
    dynamic.push(cspRule(DNR_RULE_POLICY_CSP_BASE + 1, CSP_INLINE_LOCKDOWN, PRIORITY_POLICY_BASE,
      { requestDomains: Array.from(siteBlock) }));
  }
}

/** "Pause adblock on this site": allowAllRequests for the site's frames. Only site-scoped, target-less allows. */
function compileAdblockPause(
  rule: UserRule, level: Level, now: number, dynamic: DnrRule[], session: DnrRule[],
  unsupported: CompiledPolicy['unsupported'], nextId: () => number
): void {
  if (level === 'off') return;
  if (rule.expiresAt !== undefined && rule.expiresAt <= now) return;
  if (rule.effect !== 'allow' || rule.scope.kind !== 'site' || rule.target !== undefined) {
    unsupported.push({ ruleId: rule.id, reason: 'Für Werbeblocker sind nur Website-Pausen (Erlauben, ohne Ziel) möglich' });
    return;
  }
  if (rule.duration === 'once' || rule.cookieStoreId !== undefined) {
    unsupported.push({ ruleId: rule.id, reason: 'Einmal-/Container-Regel nicht erzwingbar' });
    return;
  }
  const condition: DnrRule['condition'] = { requestDomains: [rule.scope.site], resourceTypes: ['main_frame', 'sub_frame'] };
  if (rule.duration === 'tab') {
    if (rule.tabId === undefined) return;
    condition.tabIds = [rule.tabId];
  }
  const toSession = rule.duration === 'session' || rule.duration === 'tab';
  const id = nextId();
  if ((toSession && id > DNR_RULE_POLICY_SESSION_END) || (!toSession && id >= DNR_RULE_POLICY_USER_BASE + MAX_POLICY_USER_RULES)) {
    unsupported.push({ ruleId: rule.id, reason: 'Regelkontingent erschöpft' });
    return;
  }
  (toSession ? session : dynamic).push({ id, priority: PRIORITY_ADBLOCK_PAUSE, action: { type: 'allowAllRequests' }, condition });
}

export function compilePolicyRules(state: PolicyState, now: number = Date.now(), extensionHost?: string): CompiledPolicy {
  const levels = effectiveLevels(state);
  const dynamic = baseBlocks(levels.network, levels.scripts, extensionHost);
  const session: DnrRule[] = [];
  const unsupported: CompiledPolicy['unsupported'] = [];
  let dynId = DNR_RULE_POLICY_USER_BASE;
  let sesId = DNR_RULE_POLICY_SESSION_BASE;

  compileInline(state, levels.inline, now, dynamic, unsupported);

  for (const rule of state.rules) {
    if (rule.module === 'inline') continue; // compiled collectively above
    if (rule.module === 'adblock') {
      compileAdblockPause(rule, levels.adblock, now, dynamic, session, unsupported, () => (rule.duration === 'permanent' ? dynId++ : sesId++));
      continue;
    }
    const types = typesFor(rule.module);
    if (!types) continue; // not a network/scripts rule
    if (levels[rule.module] === 'off') continue;
    if (rule.expiresAt !== undefined && rule.expiresAt <= now) continue;
    if (rule.duration === 'once') {
      unsupported.push({ ruleId: rule.id, reason: 'Einmalfreigabe ist per declarativeNetRequest nicht erzwingbar' });
      continue;
    }
    if (rule.cookieStoreId !== undefined) {
      unsupported.push({ ruleId: rule.id, reason: 'Container-Bindung ist per declarativeNetRequest nicht erzwingbar' });
      continue;
    }
    if (rule.expiresAt !== undefined) {
      unsupported.push({ ruleId: rule.id, reason: 'Ablaufzeit wird nur über Bereinigung erzwungen, nicht in der Regel selbst' });
    }
    const condition: DnrRule['condition'] = { resourceTypes: types };
    if (rule.target !== undefined) condition.requestDomains = [rule.target];
    if (rule.scope.kind === 'site') condition.initiatorDomains = [rule.scope.site];

    if (rule.duration === 'tab') {
      if (rule.tabId === undefined) continue;
      condition.tabIds = [rule.tabId]; // session rules only
    }
    const toSession = rule.duration === 'session' || rule.duration === 'tab';
    const id = toSession ? sesId++ : dynId++;
    if ((toSession && id > DNR_RULE_POLICY_SESSION_END) || (!toSession && id >= DNR_RULE_POLICY_USER_BASE + MAX_POLICY_USER_RULES)) {
      unsupported.push({ ruleId: rule.id, reason: 'Regelkontingent erschöpft' });
      continue;
    }
    const compiled: DnrRule = {
      id, priority: userRulePriority(rule), action: { type: rule.effect === 'allow' ? 'allow' : 'block' }, condition
    };
    (toSession ? session : dynamic).push(compiled);
  }
  return { dynamic, session, unsupported };
}
