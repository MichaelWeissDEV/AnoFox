import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PolicyEngine, defaultPolicyState, setProfile, setModuleLevel, effectiveLevels, pruneRules, PROFILE_LEVELS
} from '../src/core/policy-engine/policy.ts';
import type { RequestContext, UserRule, PolicyState } from '../src/core/policy-engine/policy.ts';
import { registrableDomain, isThirdParty, hostMatches } from '../src/core/domain-utils/domains.ts';

const rule = (o: Partial<UserRule> & Pick<UserRule, 'module' | 'effect'>): UserRule => ({
  id: 'r' + Math.random().toString(36).slice(2), scope: { kind: 'global' }, duration: 'permanent', createdAt: 1, ...o
});
const ctx = (o: Partial<RequestContext> = {}): RequestContext => ({
  topHost: 'news.example.org', targetUrl: 'https://cdn.other.net/app.js', resourceType: 'script', tabId: 7, ...o
});
const withRules = (profile: PolicyState['profile'], rules: UserRule[]): PolicyState => ({ ...defaultPolicyState(), profile, rules });

test('registrable domain and third-party detection', () => {
  assert.equal(registrableDomain('a.b.example.co.uk'), 'example.co.uk');
  assert.equal(registrableDomain('user.github.io'), 'user.github.io');
  assert.equal(registrableDomain('www.example.com'), 'example.com');
  assert.equal(registrableDomain('127.0.0.1'), '127.0.0.1');
  assert.equal(isThirdParty('www.example.com', 'cdn.example.com'), false);
  assert.equal(isThirdParty('a.github.io', 'b.github.io'), true);
  assert.equal(hostMatches('x.co.uk', 'co.uk'), false); // bare public suffix never matches
  assert.equal(hostMatches('sub.example.com', '*.example.com'), true);
  assert.equal(hostMatches('badexample.com', 'example.com'), false);
});

test('profiles: balanced allows, strict blocks third-party scripts, lockdown denies scripts', () => {
  const e = new PolicyEngine();
  assert.equal(e.decide(ctx(), setProfile(defaultPolicyState(), 'balanced')).action, 'allow');
  const strict = e.decide(ctx(), setProfile(defaultPolicyState(), 'strict'));
  assert.equal(strict.action, 'block');
  assert.equal(strict.module, 'scripts');
  assert.equal(e.decide(ctx({ targetUrl: 'https://news.example.org/a.js' }), setProfile(defaultPolicyState(), 'strict')).action, 'allow');
  assert.equal(e.decide(ctx({ targetUrl: 'https://news.example.org/a.js' }), setProfile(defaultPolicyState(), 'lockdown')).action, 'block');
});

test('user allow only overrides its own module', () => {
  const e = new PolicyEngine();
  e.register('malware', (c) => c.targetUrl.includes('evil.test') ? { block: true, reason: 'malware list' } : null);
  e.register('social', (c) => c.targetUrl.includes('youtube.com/embed') ? { block: true, reason: 'embed' } : null);

  const embed = ctx({ targetUrl: 'https://www.youtube.com/embed/x', resourceType: 'sub_frame' });
  const st = withRules('balanced', [rule({ module: 'social', effect: 'allow', scope: { kind: 'site', site: 'news.example.org' } })]);
  assert.equal(e.decide(embed, st).action, 'allow');

  // The same social allow must not unblock a malware hit
  const bad = ctx({ targetUrl: 'https://evil.test/embed.js' });
  assert.equal(e.decide(bad, st).action, 'block');
  assert.equal(e.decide(bad, st).module, 'malware');

  // Malware hit on an embed URL stays blocked even though social is allowed
  e.register('malware', () => ({ block: true, reason: 'malware list' }));
  const d = e.decide(embed, st);
  assert.equal(d.action, 'block');
  assert.equal(d.module, 'malware');
});

test('precedence: site beats global, exact target beats parent, block beats allow, newer wins', () => {
  const e = new PolicyEngine();
  const strictCtx = ctx();
  const siteAllow = rule({ module: 'scripts', effect: 'allow', scope: { kind: 'site', site: 'news.example.org' } });
  const globalBlock = rule({ module: 'scripts', effect: 'block' });
  assert.equal(e.decide(strictCtx, withRules('strict', [siteAllow, globalBlock])).action, 'allow');

  const parentBlock = rule({ module: 'scripts', effect: 'block', target: 'other.net' });
  const exactAllow = rule({ module: 'scripts', effect: 'allow', target: 'cdn.other.net' });
  assert.equal(e.decide(strictCtx, withRules('strict', [parentBlock, exactAllow])).action, 'allow');

  const a = rule({ module: 'scripts', effect: 'allow', target: 'cdn.other.net' });
  const b = rule({ module: 'scripts', effect: 'block', target: 'cdn.other.net' });
  assert.equal(e.decide(strictCtx, withRules('strict', [a, b])).action, 'block');
  assert.equal(e.decide(strictCtx, withRules('strict', [b, a])).action, 'block');

  const old = rule({ module: 'scripts', effect: 'allow', createdAt: 1, id: 'a' });
  const neu = rule({ module: 'scripts', effect: 'allow', createdAt: 2, id: 'b' });
  assert.equal(e.decide(strictCtx, withRules('strict', [old, neu])).ruleId, 'b');
});

test('duration semantics: once consumed, tab bound, expiry, container', () => {
  const e = new PolicyEngine();
  const once = rule({ module: 'scripts', effect: 'allow', duration: 'once' });
  const d = e.decide(ctx(), withRules('strict', [once]));
  assert.equal(d.action, 'allow');
  assert.deepEqual(d.consumedRuleIds, [once.id]);

  const tab = rule({ module: 'scripts', effect: 'allow', duration: 'tab', tabId: 7 });
  assert.equal(e.decide(ctx({ tabId: 7 }), withRules('strict', [tab])).action, 'allow');
  assert.equal(e.decide(ctx({ tabId: 8 }), withRules('strict', [tab])).action, 'block');
  const tabNoId = rule({ module: 'scripts', effect: 'allow', duration: 'tab' });
  assert.equal(e.decide(ctx(), withRules('strict', [tabNoId])).action, 'block');

  const exp = rule({ module: 'scripts', effect: 'allow', expiresAt: 1000 });
  assert.equal(e.decide(ctx(), withRules('strict', [exp]), 999).action, 'allow');
  assert.equal(e.decide(ctx(), withRules('strict', [exp]), 1000).action, 'block');

  const box = rule({ module: 'scripts', effect: 'allow', cookieStoreId: 'firefox-container-1' });
  assert.equal(e.decide(ctx({ cookieStoreId: 'firefox-container-2' }), withRules('strict', [box])).action, 'block');
  assert.equal(e.decide(ctx({ cookieStoreId: 'firefox-container-1' }), withRules('strict', [box])).action, 'allow');
});

test('site rules do not leak to look-alike domains', () => {
  const e = new PolicyEngine();
  const r = rule({ module: 'scripts', effect: 'allow', scope: { kind: 'site', site: 'example.org' } });
  assert.equal(e.decide(ctx({ topHost: 'evilexample.org' }), withRules('strict', [r])).action, 'block');
  assert.equal(e.decide(ctx({ topHost: 'sub.example.org' }), withRules('strict', [r])).action, 'allow');
});

test('profile switch keeps user rules; module toggle creates custom from preset', () => {
  const r = rule({ module: 'scripts', effect: 'allow' });
  let s = withRules('strict', [r]);
  s = setProfile(s, 'lockdown');
  assert.deepEqual(s.rules, [r]);
  s = setModuleLevel(s, 'tracking', 'off');
  assert.equal(s.profile, 'custom');
  assert.equal(effectiveLevels(s).tracking, 'off');
  assert.equal(effectiveLevels(s).scripts, PROFILE_LEVELS.lockdown.scripts);
  assert.equal(PROFILE_LEVELS.lockdown.consent === 'strict', true);
  assert.deepEqual(s.rules, [r]);
});

test('module off disables both its verdicts and rules; decision trace is complete', () => {
  const e = new PolicyEngine();
  const s = setModuleLevel(withRules('strict', []), 'scripts', 'off');
  const d = e.decide(ctx(), s);
  assert.equal(d.action, 'allow');
  assert.equal(d.trace.length, 12);
});

test('pruneRules drops expired, closed-tab and session rules', () => {
  const keep = rule({ module: 'scripts', effect: 'allow' });
  const expired = rule({ module: 'scripts', effect: 'allow', expiresAt: 5 });
  const tab = rule({ module: 'scripts', effect: 'allow', duration: 'tab', tabId: 3 });
  const sess = rule({ module: 'scripts', effect: 'allow', duration: 'session' });
  const out = pruneRules([keep, expired, tab, sess], 10, { openTabIds: new Set([4]), sessionEnded: true });
  assert.deepEqual(out, [keep]);
});
