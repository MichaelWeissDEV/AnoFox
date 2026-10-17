import test from 'node:test';
import assert from 'node:assert/strict';
import { compilePolicyRules, CSP_INLINE_LOCKDOWN, CSP_INLINE_STRICT, DNR_RULE_POLICY_CSP_BASE } from '../src/protection/network/compile.ts';
import { defaultPolicyState, PROFILE_LEVELS, PolicyEngine } from '../src/core/policy-engine/policy.ts';
import type { PolicyState, UserRule, ProfileId } from '../src/core/policy-engine/policy.ts';
import { planDnr } from '../src/core/policy-engine/apply.ts';
import { defaultSettings } from '../src/core/settings/settings.ts';

const rule = (o: Partial<UserRule> & Pick<UserRule, 'effect'>): UserRule => ({
  id: 'r' + Math.random().toString(36).slice(2), module: 'inline', scope: { kind: 'global' }, duration: 'permanent', createdAt: 1, ...o
});
const state = (profile: ProfileId, rules: UserRule[] = []): PolicyState => ({ ...defaultPolicyState(), profile, rules });
const csp = (rules: ReturnType<typeof compilePolicyRules>['dynamic']) => rules.filter((r) => r.action.type === 'modifyHeaders');
const header = (r: { action: { responseHeaders?: Array<{ header: string; operation: string; value?: string }> } }) => r.action.responseHeaders![0];

test('profiles: inline CSP only in lockdown by default', () => {
  assert.equal(PROFILE_LEVELS.balanced.inline, 'off');
  assert.equal(PROFILE_LEVELS.strict.inline, 'off');
  assert.equal(PROFILE_LEVELS.lockdown.inline, 'lockdown');
  assert.equal(csp(compilePolicyRules(state('balanced')).dynamic).length, 0);
  assert.equal(csp(compilePolicyRules(state('strict')).dynamic).length, 0);
  const l = csp(compilePolicyRules(state('lockdown')).dynamic);
  assert.equal(l.length, 1);
  assert.equal(l[0].id, DNR_RULE_POLICY_CSP_BASE);
});

test('CSP rules only ever APPEND the header on documents (never set/remove)', () => {
  const custom: PolicyState = { ...state('custom'), customLevels: { ...PROFILE_LEVELS.strict, inline: 'strict' } };
  const rules = csp(compilePolicyRules({ ...custom, rules: [rule({ effect: 'block', scope: { kind: 'site', site: 'a.example' } })] }).dynamic);
  assert.ok(rules.length >= 2);
  for (const r of rules) {
    const h = header(r as never);
    assert.equal(h.header, 'content-security-policy');
    assert.equal(h.operation, 'append');
    assert.deepEqual(r.condition.resourceTypes, ['main_frame', 'sub_frame']);
  }
  assert.equal(header(rules[0] as never).value, CSP_INLINE_STRICT);
  assert.equal(CSP_INLINE_LOCKDOWN.includes("script-src 'none'"), true);
  assert.equal(/unsafe/.test(CSP_INLINE_LOCKDOWN), false);
});

test('site allow excludes the domain from the CSP rule and creates no allow rule', () => {
  const c = compilePolicyRules(state('lockdown', [rule({ effect: 'allow', scope: { kind: 'site', site: 'shop.example' } })]));
  assert.equal(c.dynamic.filter((r) => r.action.type === 'allow').length, 0, 'allow rules would lift unrelated blocks');
  const base = csp(c.dynamic)[0];
  assert.deepEqual(base.condition.excludedRequestDomains, ['shop.example']);
  assert.equal(base.condition.requestDomains, undefined);
});

test('site block under a lenient profile adds a lockdown CSP rule for that site only', () => {
  const custom: PolicyState = { ...state('custom'), customLevels: { ...PROFILE_LEVELS.balanced, inline: 'balanced' }, rules: [rule({ effect: 'block', scope: { kind: 'site', site: 'bad.example' } })] };
  const r = csp(compilePolicyRules(custom).dynamic);
  assert.equal(r.length, 1);
  assert.deepEqual(r[0].condition.requestDomains, ['bad.example']);
  assert.equal(header(r[0] as never).value, CSP_INLINE_LOCKDOWN);
});

test('precedence: site beats global; block beats allow; global rules replace the profile base', () => {
  // global allow lifts lockdown everywhere, site block still applies
  const a = compilePolicyRules(state('lockdown', [rule({ effect: 'allow' }), rule({ effect: 'block', scope: { kind: 'site', site: 'x.example' } })]));
  const ar = csp(a.dynamic);
  assert.equal(ar.length, 1);
  assert.deepEqual(ar[0].condition.requestDomains, ['x.example']);
  // global block under a lenient profile
  const b = csp(compilePolicyRules({ ...state('balanced'), customLevels: PROFILE_LEVELS.balanced, profile: 'custom', rules: [rule({ effect: 'block' })] }).dynamic);
  assert.equal(b.length, 0, 'module off ignores rules (balanced profile has inline off)');
  const custom = { ...state('custom'), customLevels: { ...PROFILE_LEVELS.balanced, inline: 'balanced' as const }, rules: [rule({ effect: 'block' })] };
  const c = csp(compilePolicyRules(custom).dynamic);
  assert.equal(c.length, 1);
  assert.equal(header(c[0] as never).value, CSP_INLINE_LOCKDOWN);
  // same site both allow and block: block wins (the site is excluded from base, covered by the block rule)
  const d = compilePolicyRules(state('lockdown', [
    rule({ effect: 'allow', scope: { kind: 'site', site: 'y.example' } }), rule({ effect: 'block', scope: { kind: 'site', site: 'y.example' } })
  ]));
  const dr = csp(d.dynamic);
  assert.equal(dr.length, 2);
  assert.ok(dr.some((r) => r.condition.requestDomains?.includes('y.example')));
  assert.ok(dr.some((r) => r.condition.excludedRequestDomains?.includes('y.example')));
});

test('unsupported durations/targets are reported and have no effect', () => {
  const c = compilePolicyRules(state('lockdown', [
    rule({ id: 't', effect: 'allow', duration: 'tab', tabId: 3, scope: { kind: 'site', site: 'a.example' } }),
    rule({ id: 'o', effect: 'allow', duration: 'once' }),
    rule({ id: 'g', effect: 'allow', target: 'cdn.example', scope: { kind: 'site', site: 'a.example' } }),
    rule({ id: 's', effect: 'allow', duration: 'session', scope: { kind: 'site', site: 'b.example' } })
  ]));
  assert.deepEqual(c.unsupported.map((u) => u.ruleId).sort(), ['g', 'o', 't']);
  assert.deepEqual(csp(c.dynamic)[0].condition.excludedRequestDomains, ['b.example']);
  assert.equal(c.session.length, 0);
});

test('module off ignores inline rules; expired rules are ignored; engine never turns inline rules into request verdicts', () => {
  const off = compilePolicyRules({ ...state('custom'), customLevels: { ...PROFILE_LEVELS.lockdown, inline: 'off' }, rules: [rule({ effect: 'block' })] });
  assert.equal(csp(off.dynamic).length, 0);
  const exp = compilePolicyRules(state('lockdown', [rule({ effect: 'allow', expiresAt: 5, scope: { kind: 'site', site: 'e.example' } })]), 10);
  assert.equal(csp(exp.dynamic)[0].condition.excludedRequestDomains, undefined);
  const e = new PolicyEngine();
  const d = e.decide({ topHost: 'a.example', targetUrl: 'https://a.example/', resourceType: 'sub_frame' },
    { ...state('balanced'), rules: [rule({ effect: 'block' })] });
  assert.equal(d.action, 'allow');
});

test('planDnr includes CSP rules in lockdown and keeps rule ids unique', () => {
  const s = defaultSettings();
  const plan = planDnr({ ...s, profile: 'lockdown', rules: [
    { id: 'a', module: 'inline', effect: 'block', scope: { kind: 'site', site: 'x.example' }, duration: 'permanent', createdAt: 1 },
    { id: 'b', module: 'scripts', effect: 'allow', scope: { kind: 'site', site: 'x.example' }, duration: 'permanent', createdAt: 2 }
  ] });
  const ids = plan.options.policyRules!.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(plan.options.policyRules!.some((r) => r.action.type === 'modifyHeaders'));
});
