import test from 'node:test';
import assert from 'node:assert/strict';
import { PolicyEngine, defaultPolicyState, effectiveLevels } from '../src/core/policy-engine/policy.ts';
import type { PolicyState, UserRule, RequestContext, ResourceType, ProfileId } from '../src/core/policy-engine/policy.ts';
import { compilePolicyRules, userRulePriority } from '../src/protection/network/compile.ts';
import { planDnr } from '../src/core/policy-engine/apply.ts';
import { defaultSettings, normalizeSettings } from '../src/core/settings/settings.ts';
import { buildDnrRules, PRIORITY_EMBED_BLOCK } from '../src/dnr-manager.ts';
import { registrableDomain } from '../src/core/domain-utils/domains.ts';

type DnrRule = browser.declarativeNetRequest.Rule;

/** Minimal model of DNR evaluation: highest priority wins, allow beats block on equal priority. */
function dnrVerdict(rules: DnrRule[], c: RequestContext): 'allow' | 'block' {
  const host = new URL(c.targetUrl).hostname;
  const matching = rules.filter((r) => {
    const k = r.condition;
    if (k.resourceTypes && !k.resourceTypes.includes(c.resourceType as never)) return false;
    if (k.domainType === 'thirdParty' && registrableDomain(c.topHost) === registrableDomain(host)) return false;
    if (k.requestDomains && !k.requestDomains.some((d) => host === d || host.endsWith('.' + d))) return false;
    if (k.initiatorDomains && !k.initiatorDomains.some((d) => c.topHost === d || c.topHost.endsWith('.' + d))) return false;
    if (k.tabIds && !k.tabIds.includes(c.tabId ?? -1)) return false;
    return r.action.type === 'allow' || r.action.type === 'block';
  });
  if (matching.length === 0) return 'allow';
  const top = Math.max(...matching.map((r) => r.priority ?? 1));
  const best = matching.filter((r) => (r.priority ?? 1) === top);
  return best.some((r) => r.action.type === 'allow') ? 'allow' : 'block';
}

const mk = (o: Partial<UserRule> & Pick<UserRule, 'module' | 'effect'>, n: number): UserRule => ({
  id: 'r' + n, scope: { kind: 'global' }, duration: 'permanent', createdAt: n, ...o
});

test('compiled DNR verdicts match the policy engine for scripts and network modules', () => {
  const engine = new PolicyEngine();
  const targets = ['https://cdn.other.net/x', 'https://www.other.net/x', 'https://news.example.org/x'];
  const types: ResourceType[] = ['script', 'sub_frame', 'font', 'image', 'xmlhttprequest', 'stylesheet'];
  const tops = ['news.example.org', 'blog.example.com'];
  const ruleSets: UserRule[][] = [
    [],
    [mk({ module: 'scripts', effect: 'allow', scope: { kind: 'site', site: 'news.example.org' } }, 1)],
    [mk({ module: 'scripts', effect: 'allow', target: 'cdn.other.net' }, 1), mk({ module: 'scripts', effect: 'block' }, 2)],
    [mk({ module: 'scripts', effect: 'allow' }, 1), mk({ module: 'scripts', effect: 'block', scope: { kind: 'site', site: 'blog.example.com' } }, 2)],
    [mk({ module: 'network', effect: 'allow', target: 'other.net' }, 1)],
    [mk({ module: 'network', effect: 'allow', scope: { kind: 'site', site: 'news.example.org' }, target: 'other.net' }, 1), mk({ module: 'network', effect: 'block', target: 'cdn.other.net' }, 2)],
    [mk({ module: 'scripts', effect: 'allow', duration: 'session' }, 1), mk({ module: 'network', effect: 'allow', duration: 'tab', tabId: 7 }, 2)],
    // an embed (social) rule must never change network/scripts results
    [mk({ module: 'social', effect: 'allow' }, 1)]
  ];
  let compared = 0;
  for (const profile of ['balanced', 'strict', 'lockdown'] as ProfileId[]) {
    for (const rules of ruleSets) {
      const state: PolicyState = { ...defaultPolicyState(), profile, rules };
      const compiled = compilePolicyRules(state);
      const all = [...compiled.dynamic, ...compiled.session];
      for (const topHost of tops) for (const targetUrl of targets) for (const resourceType of types) {
        const c: RequestContext = { topHost, targetUrl, resourceType, tabId: 7 };
        const d = engine.decide(c, state);
        assert.equal(dnrVerdict(all, c), d.action,
          `${profile} ${JSON.stringify(rules.map((r) => [r.module, r.effect, r.target, r.scope.kind]))} ${topHost} -> ${targetUrl} (${resourceType})`);
        compared++;
      }
    }
  }
  assert.ok(compared > 800);
});

test('user rules cannot lift Social Embed Guard blocks (priority isolation)', async () => {
  const state: PolicyState = { ...defaultPolicyState(), profile: 'strict', rules: [
    mk({ module: 'network', effect: 'allow' }, 1), mk({ module: 'scripts', effect: 'allow' }, 2)
  ] };
  const compiled = compilePolicyRules(state);
  const embed = await buildDnrRules({ enabled: false, exceptions: [], socialEmbedsEnabled: true });
  const yt: RequestContext = { topHost: 'a.example', targetUrl: 'https://www.youtube.com/embed/x', resourceType: 'sub_frame' };
  // model embed filter as host+path match for the verdict helper
  const ytBlock = embed.find((r) => r.condition.urlFilter === '||youtube.com/embed/')!;
  const model: DnrRule = { ...ytBlock, condition: { resourceTypes: ytBlock.condition.resourceTypes, requestDomains: ['youtube.com'] } };
  assert.equal(dnrVerdict([...compiled.dynamic, model], yt), 'block');
  for (const r of compiled.dynamic) assert.ok((r.priority ?? 0) < PRIORITY_EMBED_BLOCK);
});

test('priority function mirrors specificity ordering', () => {
  const p = (o: Partial<UserRule>) => userRulePriority(mk({ module: 'scripts', effect: 'allow', ...o }, 1));
  assert.ok(p({ scope: { kind: 'site', site: 'a.b' } }) > p({ target: 'x.y' }) - 1);
  assert.ok(p({ effect: 'block' }) > p({ effect: 'allow' }));
  assert.ok(p({ target: 'x.y' }) > p({}));
  assert.ok(p({ scope: { kind: 'site', site: 'a.b' } }) > p({ target: 'x.y', effect: 'block' }));
});

test('unsupported durations are reported, not silently dropped', () => {
  const state: PolicyState = { ...defaultPolicyState(), profile: 'strict', rules: [
    mk({ module: 'scripts', effect: 'allow', duration: 'once' }, 1),
    mk({ module: 'scripts', effect: 'allow', cookieStoreId: 'c1' }, 2),
    mk({ module: 'scripts', effect: 'allow', expiresAt: 1 }, 3)
  ] };
  const c = compilePolicyRules(state, 1000); // rule 3 already expired -> skipped silently by design
  assert.deepEqual(c.unsupported.map((u) => u.ruleId).sort(), ['r1', 'r2']);
  assert.equal(c.dynamic.filter((r) => r.action.type === 'allow').length, 0);
});

test('planDnr maps profile + kill switches to DNR input; profile switch keeps rules', () => {
  let s = defaultSettings();
  let plan = planDnr(s);
  assert.equal(plan.options.enabled, true);
  assert.equal(plan.options.socialEmbedsEnabled, true);
  assert.equal(plan.options.policyRules!.length, 0); // balanced: no network/script base blocks

  s = normalizeSettings({ ...s, profile: 'strict', rules: [mk({ module: 'scripts', effect: 'allow', target: 'cdn.example.net' }, 1)] }, s);
  plan = planDnr(s);
  assert.ok(plan.options.policyRules!.some((r) => r.action.type === 'block'));
  assert.ok(plan.options.policyRules!.some((r) => r.action.type === 'allow' && r.condition.requestDomains?.[0] === 'cdn.example.net'));

  s = normalizeSettings({ ...s, profile: 'lockdown', socialEmbedsEnabled: false }, s);
  assert.equal(s.rules.length, 1);
  assert.equal(planDnr(s).options.socialEmbedsEnabled, false);
  assert.equal(effectiveLevels({ profile: s.profile, customLevels: s.customLevels, rules: s.rules }).scripts, 'lockdown');

  // module set to off in custom profile removes its blocks and ignores its rules
  s = normalizeSettings({ ...s, profile: 'custom', customLevels: { ...s.customLevels, scripts: 'off', network: 'off', tracking: 'off' } }, s);
  plan = planDnr(s);
  assert.equal(plan.options.policyRules!.length, 0);
  assert.equal(plan.options.enabled, false);
});

test('settings validation rejects malformed rules and never widens a site rule to global', () => {
  const s = normalizeSettings({ rules: [
    { id: 'a', module: 'scripts', effect: 'allow', duration: 'permanent', scope: { kind: 'site', site: 'nodot' } },
    { id: 'b', module: 'nope', effect: 'allow', duration: 'permanent', scope: { kind: 'global' } },
    { id: 'c', module: 'scripts', effect: 'allow', duration: 'permanent', scope: { kind: 'site', site: 'https://Example.com/x' }, target: 'cdn.example.net' },
    { id: 'c', module: 'scripts', effect: 'block', duration: 'permanent', scope: { kind: 'global' } },
    'garbage', null
  ] });
  assert.equal(s.rules.length, 1);
  assert.deepEqual(s.rules[0].scope, { kind: 'site', site: 'example.com' });
  assert.equal(s.rules[0].target, 'cdn.example.net');
});

test('default-deny base rules never apply to requests issued by the extension itself', () => {
  const lock = compilePolicyRules({ ...defaultPolicyState(), profile: 'lockdown' }, Date.now(), 'ext-uuid-host');
  const blocks = lock.dynamic.filter((r) => r.action.type === 'block');
  assert.ok(blocks.length >= 2);
  for (const b of blocks) assert.deepEqual(b.condition.excludedInitiatorDomains, ['ext-uuid-host']);
  const without = compilePolicyRules({ ...defaultPolicyState(), profile: 'lockdown' });
  assert.equal(without.dynamic.find((r) => r.action.type === 'block')!.condition.excludedInitiatorDomains, undefined);
});
