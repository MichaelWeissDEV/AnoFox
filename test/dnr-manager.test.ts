import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeDomainList, buildDnrRules, buildTempEmbedAllowRule, RedirectLoopGuard,
  DNR_RULE_REDIRECT_TRACKING, DNR_RULE_ALLOW_EXCEPTIONS, DNR_RULE_ALLOW_AUTH_SIGNED,
  isTrackingRedirectRuleId,
  PRIORITY_CLEANER_ALLOW, PRIORITY_EMBED_BLOCK, PRIORITY_EMBED_ALLOW_TEMP
} from '../src/dnr-manager.ts';
import { generateAuthParamRegex, isSignedOrAuthUrl } from '../src/url-cleaner.ts';
import { SUPPORTED_EMBED_PROVIDERS } from '../src/embed-guard.ts';

test('sanitizeDomainList formats and filters domain exceptions', () => {
  const input = [
    'https://example.com/some/path?param=1',
    '*.sub.test.org',
    'http://localhost:8080',
    'singleword', // no dot -> ignored
    '  clean-domain.co.uk  ',
    ''
  ];
  const output = sanitizeDomainList(input);
  assert.deepEqual(output.sort(), ['clean-domain.co.uk', 'example.com', 'sub.test.org'].sort());
});

test('buildDnrRules produces redirect and allow rules when enabled', async () => {
  const rules = await buildDnrRules({
    enabled: true,
    exceptions: ['example.org']
  });

  const redirectRule = rules.find(r => r.id === DNR_RULE_REDIRECT_TRACKING);
  assert.ok(redirectRule);
  assert.equal(redirectRule.action.type, 'redirect');
  assert.ok(redirectRule.action.redirect?.transform?.queryTransform?.removeParams);
  assert.deepEqual(redirectRule.condition.excludedRequestDomains, ['example.org']);
  assert.deepEqual(redirectRule.condition.resourceTypes, ['main_frame', 'sub_frame']);

  const exceptionsRule = rules.find(r => r.id === DNR_RULE_ALLOW_EXCEPTIONS);
  assert.ok(exceptionsRule);
  assert.equal(exceptionsRule.action.type, 'allow');
  assert.deepEqual(exceptionsRule.condition.requestDomains, ['example.org']);

  const authRule = rules.find(r => r.id === DNR_RULE_ALLOW_AUTH_SIGNED);
  assert.ok(authRule);
  assert.equal(authRule.action.type, 'allow');
  assert.ok(authRule.condition.regexFilter);
});

test('buildDnrRules returns empty array when enabled is false', async () => {
  const rules = await buildDnrRules({
    enabled: false,
    exceptions: ['example.org']
  });
  assert.deepEqual(rules, []);
});

test('RedirectLoopGuard detects rapid redirect loops', () => {
  const guard = new RedirectLoopGuard();
  const domain = 'looping-site.com';

  assert.equal(guard.checkAndRecord(domain), true);
  assert.equal(guard.checkAndRecord(domain), true);
  assert.equal(guard.checkAndRecord(domain), true);
  // 4th call within same millisecond triggers loop detection
  assert.equal(guard.checkAndRecord(domain), false);
  assert.equal(guard.isLoopBlocked(domain), true);

  // Other domains are unaffected
  assert.equal(guard.checkAndRecord('safe-site.com'), true);
});

test('tracking redirect rules only match URLs that carry a tracking parameter', async () => {
  const rules = await buildDnrRules({ enabled: true, exceptions: [] });
  const redirects = rules.filter((r) => isTrackingRedirectRuleId(r.id));
  assert.ok(redirects.length >= 1);
  for (const r of redirects) {
    assert.ok(r.condition.regexFilter, 'redirect must not use a catch-all filter');
    assert.notEqual(r.condition.urlFilter, '*');
  }
  const matches = (url: string) => redirects.some((r) => new RegExp(r.condition.regexFilter!, 'i').test(url));
  assert.equal(matches('https://a.example/p?utm_source=x'), true);
  assert.equal(matches('https://a.example/p?q=1&FBCLID=2'), true);
  assert.equal(matches('https://a.example/p?q=1'), false);
  assert.equal(matches('https://a.example/p?myutm_source=1'), false);
});

test('auth allow regex agrees with the JS signed/auth detection', () => {
  const re = new RegExp(generateAuthParamRegex(), 'i');
  for (const q of ['access_token=1', 'SAMLResponse=1', 'X-Amz-Credential=a', 'id_token=x', 'sig=1&utm_source=a']) {
    const url = 'https://x.example/cb?' + q;
    assert.equal(isSignedOrAuthUrl(new URL(url)), true, url);
    assert.equal(re.test(url), true, url);
  }
  assert.equal(re.test('https://x.example/?utm_source=a'), false);
});

test('embed site exceptions match the initiator, not the embed host (S-1)', async () => {
  const rules = await buildDnrRules({
    enabled: false, exceptions: [], socialEmbedsEnabled: true, socialEmbedExceptions: ['news.example.org']
  });
  // no blanket allow rule any more: it would have lifted every other block for that initiator
  assert.equal(rules.filter((r) => r.action.type === 'allow').length, 0);
  const blocks = rules.filter((r) => r.action.type === 'block');
  assert.ok(blocks.length > 0);
  for (const b of blocks) {
    assert.deepEqual(b.condition.excludedInitiatorDomains, ['news.example.org']);
    assert.equal(b.condition.excludedRequestDomains, undefined);
  }
});

test('priority bands: cleaner allow rules cannot override embed blocks (S-2)', async () => {
  const rules = await buildDnrRules({
    enabled: true, exceptions: ['x.example.org'], socialEmbedsEnabled: true, socialEmbedExceptions: ['y.example.org']
  });
  const cleanerAllows = rules.filter((r) => r.id === DNR_RULE_ALLOW_EXCEPTIONS || r.id === DNR_RULE_ALLOW_AUTH_SIGNED);
  assert.equal(cleanerAllows.length, 2);
  for (const a of cleanerAllows) assert.equal(a.priority, PRIORITY_CLEANER_ALLOW);
  for (const b of rules.filter((r) => r.action.type === 'block')) {
    assert.ok(b.priority! > PRIORITY_CLEANER_ALLOW);
    assert.equal(b.priority, PRIORITY_EMBED_BLOCK);
  }
  assert.ok(PRIORITY_EMBED_ALLOW_TEMP > PRIORITY_EMBED_BLOCK);
});

test('rule IDs are unique and stable when providers are toggled', async () => {
  const all = await buildDnrRules({ enabled: true, exceptions: ['a.example'], socialEmbedsEnabled: true, socialEmbedExceptions: ['b.example'] });
  const ids = all.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length);

  const noYoutube = await buildDnrRules({
    enabled: false, exceptions: [], socialEmbedsEnabled: true,
    socialEmbedProviders: { youtube: false, instagram: true, tiktok: true, facebook: true, twitter: true, vimeo: true, spotify: true, twitch: true, soundcloud: true }
  });
  const vimeoWith = all.find((r) => r.condition.urlFilter?.includes('vimeo'))!;
  const vimeoWithout = noYoutube.find((r) => r.condition.urlFilter?.includes('vimeo'))!;
  assert.equal(vimeoWith.id, vimeoWithout.id);
});

test('embed urlFilters use domain anchors and match bare and subdomain hosts (S-4)', () => {
  // Minimal urlFilter emulation for "||host/path" (+ "*" wildcard)
  const matches = (filter: string, url: string) => {
    assert.ok(filter.startsWith('||'), filter);
    const u = new URL(url);
    const [hostPart, ...pathParts] = filter.slice(2).split('/');
    const hostOk = u.hostname === hostPart || u.hostname.endsWith('.' + hostPart);
    const pathRe = new RegExp('^/' + pathParts.join('/').split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*'));
    return hostOk && pathRe.test(u.pathname);
  };
  const yt = SUPPORTED_EMBED_PROVIDERS.find((p) => p.id === 'youtube')!;
  assert.ok(yt.dnrFilters.some((f) => matches(f, 'https://youtube.com/embed/abc')));
  assert.ok(yt.dnrFilters.some((f) => matches(f, 'https://www.youtube.com/embed/abc')));
  assert.ok(!yt.dnrFilters.some((f) => matches(f, 'https://evil.example/?u=https://www.youtube.com/embed/abc')));
  for (const p of SUPPORTED_EMBED_PROVIDERS) {
    for (const f of p.dnrFilters) assert.ok(f.startsWith('||') && !f.includes('://'), f);
  }
});

test('temporary embed allow rule: exact URL, known providers only, regex-escaped (S-3)', () => {
  const url = 'https://www.youtube.com/embed/abc?x=1&y=*|^';
  const rule = buildTempEmbedAllowRule(url, 3001)!;
  assert.ok(rule);
  assert.equal(rule.condition.urlFilter, undefined);
  const re = new RegExp(rule.condition.regexFilter!);
  assert.equal(re.test(new URL(url).href), true);
  assert.equal(re.test('https://www.youtube.com/embed/abc?x=1&y=other'), false);
  assert.equal(buildTempEmbedAllowRule('https://tracker.example/pixel.js', 3002), null);
  assert.equal(buildTempEmbedAllowRule('javascript:alert(1)', 3003), null);
  assert.equal(buildTempEmbedAllowRule('https://www.youtube.com/embed/' + 'a'.repeat(2000), 3004), null);
});
