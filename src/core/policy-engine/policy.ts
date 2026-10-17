/**
 * Central Policy Engine (pure, no browser APIs).
 *
 * Model
 *  - A profile (balanced/strict/lockdown/custom) maps every protection module to a level.
 *  - Protection modules contribute verdicts through registered evaluators.
 *  - User rules (allow/block, global or per site, once/tab/session/permanent) are scoped to ONE
 *    module and can only change that module's verdict. An embed allow never touches malware,
 *    phishing, network or script verdicts.
 *  - Profile changes never touch the user rules.
 *
 * Precedence for user rules of one module (deterministic, first difference wins):
 *   1. site-scoped rule beats global rule
 *   2. exact host target beats parent-domain target beats no target
 *   3. block beats allow
 *   4. newer rule (createdAt, then id) wins
 * Final decision: modules are evaluated in MODULE_ORDER; the first module that ends in "block" decides.
 */

import { hostMatches, isThirdParty, normalizeHost, registrableDomain } from '../domain-utils/domains.ts';

export type ProfileId = 'balanced' | 'strict' | 'lockdown' | 'custom';
export type Level = 'off' | 'balanced' | 'strict' | 'lockdown';

/** Evaluation order = precedence between modules (hard safety modules first). */
export const MODULE_ORDER = [
  'malware', 'phishing', 'network', 'scripts', 'inline', 'social', 'adblock', 'tracking',
  'fingerprint', 'cookies', 'storage', 'consent'
] as const;
export type ModuleId = typeof MODULE_ORDER[number];

export type Levels = Record<ModuleId, Level>;

const LEVEL_RANK: Record<Level, number> = { off: 0, balanced: 1, strict: 2, lockdown: 3 };

function uniform(level: Level, over: Partial<Levels> = {}): Levels {
  const out = {} as Levels;
  for (const m of MODULE_ORDER) out[m] = level;
  return { ...out, ...over };
}

export const PROFILE_LEVELS: Record<Exclude<ProfileId, 'custom'>, Levels> = {
  // inline (CSP) is only on in lockdown by default: blocking inline scripts breaks most sites
  balanced: uniform('balanced', { scripts: 'off', network: 'off', inline: 'off' }),
  strict: uniform('strict', { scripts: 'strict', network: 'strict', inline: 'off' }),
  // consent stays at strict: auto-accepting is never a profile effect
  lockdown: uniform('lockdown', { consent: 'strict' })
};

export type ResourceType =
  | 'main_frame' | 'sub_frame' | 'script' | 'stylesheet' | 'image' | 'font' | 'media'
  | 'xmlhttprequest' | 'websocket' | 'ping' | 'object' | 'other';

export interface RequestContext {
  /** Hostname of the top-level site (the site the user sees). */
  topHost: string;
  targetUrl: string;
  resourceType: ResourceType;
  /** Hostname of the initiating document, if known. */
  initiatorHost?: string;
  tabId?: number;
  cookieStoreId?: string;
  incognito?: boolean;
}

export type Duration = 'once' | 'tab' | 'session' | 'permanent';
export type RuleScope = { kind: 'global' } | { kind: 'site'; site: string };

export interface UserRule {
  id: string;
  module: ModuleId;
  scope: RuleScope;
  /** Resource host (or parent domain) the rule applies to; undefined = every target. */
  target?: string;
  effect: 'allow' | 'block';
  duration: Duration;
  createdAt: number;
  /** Required for duration 'tab'. */
  tabId?: number;
  /** Optional absolute expiry (ms epoch) for any duration. */
  expiresAt?: number;
  /** Optional container restriction. */
  cookieStoreId?: string;
}

export interface PolicyState {
  profile: ProfileId;
  /** Levels used when profile === 'custom'. */
  customLevels: Levels;
  rules: UserRule[];
}

export type ModuleVerdict = { block: true; reason: string } | { block: false } | null;
export type ModuleEvaluator = (ctx: RequestContext, level: Level) => ModuleVerdict;

export interface TraceEntry {
  module: ModuleId;
  level: Level;
  baseVerdict: 'block' | 'allow' | 'none';
  ruleId?: string;
  outcome: 'block' | 'allow';
}

export interface Decision {
  action: 'allow' | 'block';
  module?: ModuleId;
  reason: string;
  ruleId?: string;
  /** Rules with duration 'once' that were used; the caller must remove them. */
  consumedRuleIds: string[];
  trace: TraceEntry[];
}

export function defaultPolicyState(): PolicyState {
  return { profile: 'balanced', customLevels: { ...PROFILE_LEVELS.balanced }, rules: [] };
}

export function effectiveLevels(state: PolicyState): Levels {
  return state.profile === 'custom' ? state.customLevels : PROFILE_LEVELS[state.profile];
}

export function setProfile(state: PolicyState, profile: ProfileId): PolicyState {
  // Rules are deliberately carried over untouched.
  return { ...state, profile };
}

/** Changing one module from a preset profile switches to "custom" seeded with the preset's levels. */
export function setModuleLevel(state: PolicyState, module: ModuleId, level: Level): PolicyState {
  const base = { ...effectiveLevels(state) };
  base[module] = level;
  return { ...state, profile: 'custom', customLevels: base };
}

/** Built-in evaluators for the policy-level modules. Protection modules register their own. */
const builtinEvaluators: Partial<Record<ModuleId, ModuleEvaluator>> = {
  network: (ctx, level) => {
    // scripts are owned by the `scripts` module so each resource type has exactly one owner
    if (level === 'off' || ctx.resourceType === 'main_frame' || ctx.resourceType === 'script') return null;
    const target = hostOf(ctx.targetUrl);
    if (!target || !isThirdParty(ctx.topHost, target)) return null;
    if (level === 'lockdown' && ctx.resourceType !== 'image') {
      return { block: true, reason: 'Lockdown: Drittanbieter-Ressource (Default-Deny)' };
    }
    if (level === 'strict' && (ctx.resourceType === 'sub_frame' || ctx.resourceType === 'font')) {
      return { block: true, reason: 'Strict: Drittanbieter-Frame/-Font' };
    }
    return null;
  },
  scripts: (ctx, level) => {
    if (level === 'off' || ctx.resourceType !== 'script') return null;
    const target = hostOf(ctx.targetUrl);
    if (level === 'lockdown') return { block: true, reason: 'Lockdown: Skripte standardmäßig untersagt' };
    if (level === 'strict' && target && isThirdParty(ctx.topHost, target)) {
      return { block: true, reason: 'Strict: Drittanbieter-Skript' };
    }
    return null;
  }
};

function hostOf(url: string): string | null {
  try { return normalizeHost(new URL(url).hostname); } catch { return null; }
}

export class PolicyEngine {
  private evaluators: Partial<Record<ModuleId, ModuleEvaluator>> = { ...builtinEvaluators };

  register(module: ModuleId, evaluator: ModuleEvaluator): void {
    this.evaluators[module] = evaluator;
  }

  decide(ctx: RequestContext, state: PolicyState, now: number = Date.now()): Decision {
    const levels = effectiveLevels(state);
    const targetHost = hostOf(ctx.targetUrl);
    const trace: TraceEntry[] = [];
    const consumed: string[] = [];
    let first: Decision | null = null;

    for (const module of MODULE_ORDER) {
      const level = levels[module];
      const evaluator = this.evaluators[module];
      const verdict = level !== 'off' && evaluator ? evaluator(ctx, level) : null;
      const base: 'block' | 'allow' | 'none' = verdict === null ? 'none' : verdict.block ? 'block' : 'allow';

      // A user BLOCK rule applies even when the module has no opinion; it still respects "off".
      const rule = level === 'off' ? null : pickRule(state.rules, module, ctx, targetHost, now);
      let outcome: 'block' | 'allow' = base === 'block' ? 'block' : 'allow';
      let reason = verdict && verdict.block ? verdict.reason : '';
      if (rule) {
        outcome = rule.effect;
        reason = rule.effect === 'allow' ? `Benutzerfreigabe (${rule.duration})` : 'Benutzerregel: blockieren';
        if (rule.duration === 'once') consumed.push(rule.id);
      }
      trace.push({ module, level, baseVerdict: base, ruleId: rule?.id, outcome });
      if (outcome === 'block' && !first) {
        first = { action: 'block', module, reason, ruleId: rule?.id, consumedRuleIds: [], trace: [] };
      }
    }

    if (first) {
      return { ...first, consumedRuleIds: consumed, trace };
    }
    const used = trace.find((t) => t.ruleId);
    return { action: 'allow', reason: used ? 'Durch Benutzerregel freigegeben' : 'Kein Modul blockiert', ruleId: used?.ruleId, consumedRuleIds: consumed, trace };
  }
}

/** Resource types a module's user rules apply to (undefined = all). Keeps module ownership disjoint. */
function moduleOwnsType(module: ModuleId, type: ResourceType): boolean {
  // `inline` acts on document response headers (CSP), not on request allow/block decisions
  if (module === 'inline') return false;
  if (module === 'scripts') return type === 'script';
  if (module === 'network') return type !== 'script' && type !== 'main_frame';
  return true;
}

function ruleApplies(rule: UserRule, ctx: RequestContext, targetHost: string | null, now: number): boolean {
  if (!moduleOwnsType(rule.module, ctx.resourceType)) return false;
  if (rule.expiresAt !== undefined && rule.expiresAt <= now) return false;
  if (rule.duration === 'tab' && (rule.tabId === undefined || rule.tabId !== ctx.tabId)) return false;
  if (rule.cookieStoreId !== undefined && rule.cookieStoreId !== ctx.cookieStoreId) return false;
  if (rule.scope.kind === 'site' && !hostMatches(ctx.topHost, rule.scope.site)) return false;
  if (rule.target !== undefined) {
    if (!targetHost || !hostMatches(targetHost, rule.target)) return false;
  }
  return true;
}

function specificity(rule: UserRule, targetHost: string | null): [number, number] {
  const scope = rule.scope.kind === 'site' ? 1 : 0;
  const target = rule.target === undefined ? 0 : (targetHost === normalizeHost(rule.target) ? 2 : 1);
  return [scope, target];
}

export function pickRule(
  rules: UserRule[], module: ModuleId, ctx: RequestContext, targetHost: string | null, now: number
): UserRule | null {
  let best: UserRule | null = null;
  for (const rule of rules) {
    if (rule.module !== module || !ruleApplies(rule, ctx, targetHost, now)) continue;
    if (!best || compareRules(rule, best, targetHost) > 0) best = rule;
  }
  return best;
}

function compareRules(a: UserRule, b: UserRule, targetHost: string | null): number {
  const [as, at] = specificity(a, targetHost);
  const [bs, bt] = specificity(b, targetHost);
  if (as !== bs) return as - bs;
  if (at !== bt) return at - bt;
  if (a.effect !== b.effect) return a.effect === 'block' ? 1 : -1;
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Removes rules that can never apply again (expired, tab closed, session ended). */
export function pruneRules(
  rules: UserRule[], now: number, opts: { openTabIds?: Set<number>; sessionEnded?: boolean } = {}
): UserRule[] {
  return rules.filter((r) => {
    if (r.expiresAt !== undefined && r.expiresAt <= now) return false;
    if (r.duration === 'tab' && opts.openTabIds && (r.tabId === undefined || !opts.openTabIds.has(r.tabId))) return false;
    if (r.duration === 'session' && opts.sessionEnded) return false;
    return true;
  });
}

/** Strictness helper for UI ("is this profile stricter than that one?"). */
export function levelRank(level: Level): number {
  return LEVEL_RANK[level];
}

export { registrableDomain };
