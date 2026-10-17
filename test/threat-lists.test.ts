import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { parseDomainEntries, NEVER_BLOCK } from '../src/protection/threat/domains.ts';
import {
  compileThreatRules, compileHeuristicRule, buildBypassRule, parseWarningUrl, listIdRange, USERINFO_REGEX,
  PRIORITY_THREAT, PRIORITY_THREAT_BYPASS, DOMAINS_PER_RULE, DNR_RULE_THREAT_BASE, DNR_RULE_THREAT_END
} from '../src/protection/threat/compile.ts';
import { THREAT_SOURCES, getThreatSource } from '../src/protection/threat/sources.ts';
import { ThreatListManager } from '../src/protection/threat/manager.ts';
import type { ThreatManagerDeps } from '../src/protection/threat/manager.ts';
import { PRIORITY_POLICY_BASE } from '../src/protection/network/compile.ts';
import { PRIORITY_ADBLOCK_PAUSE } from '../src/protection/network/compile.ts';
import { PRIORITY_ADBLOCK_ALLOW_ALL } from '../src/protection/adblock/compile-dnr.ts';
import { PRIORITY_CLEANER_ALLOW } from '../src/dnr-manager.ts';

const sha256 = async (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const ORIGIN = 'moz-extension://abc';

test('domain parser: formats, validation, never-block canary, dedupe, metadata', () => {
  const text = [
    '# Title: Test list', '# Updated: 2026-10-17T00:00:00Z', '# Expires: 12 hours', '',
    'Evil.Example', 'evil.example', 'sub.evil.example.', '0.0.0.0 hosts-style.example', '127.0.0.1\tother-hosts.example # comment',
    '1.62.87.116', '999.1.1.1', '0.1.2.3', 'noTld', 'has space.example', 'under_score.example', 'ünicode.example', 'http://url.example/x', 'wild*.example',
    'co.uk', 'github.io', 'mail.google.com', 'google.com', 'phish.login.example', ''
  ].join('\n');
  const r = parseDomainEntries(text);
  assert.deepEqual(r.domains, ['evil.example', 'sub.evil.example', 'hosts-style.example', 'other-hosts.example', '1.62.87.116', 'under_score.example', 'phish.login.example']);
  assert.equal(r.droppedNeverBlock, 2, 'google.com and a subdomain of it');
  assert.ok(r.invalid >= 7);
  assert.equal(r.metadata.title, 'Test list');
  assert.equal(r.metadata.expires, '12 hours');
  assert.ok(NEVER_BLOCK.has('mozilla.org'));
  assert.equal(parseDomainEntries('a.example\nb.example\nc.example', 2).truncated, true);
});

test('compiler: block + redirect per group, ids in the list range, regexSubstitution carries list id and URL', () => {
  const domains = Array.from({ length: DOMAINS_PER_RULE * 2 + 5 }, (_, i) => `d${i}.bad.example`);
  const c = compileThreatRules({ id: 'phishing-filter' }, 1, domains, ORIGIN);
  assert.equal(c.groups, 3);
  assert.equal(c.rules.length, 6);
  assert.equal(c.regexRules, 3);
  const [lo, hi] = listIdRange(1);
  for (const r of c.rules) { assert.ok(r.id >= lo && r.id <= hi); assert.equal(r.priority, PRIORITY_THREAT); }
  assert.equal(new Set(c.rules.map((r) => r.id)).size, 6);
  const block = c.rules[0], redirect = c.rules[1];
  assert.equal(block.action.type, 'block');
  assert.ok(block.condition.resourceTypes!.includes('script') && !block.condition.resourceTypes!.includes('main_frame'));
  assert.equal(redirect.action.type, 'redirect');
  assert.equal(redirect.action.redirect!.regexSubstitution, `${ORIGIN}/blocked.html?l=phishing-filter&u=\\0`);
  assert.deepEqual(redirect.condition.resourceTypes, ['main_frame']);
  assert.equal(redirect.condition.requestDomains!.length, DOMAINS_PER_RULE);
  assert.equal(c.rules.at(-1)!.condition.requestDomains!.length, 5);
  assert.throws(() => compileThreatRules({ id: 'x' }, 0, Array.from({ length: DOMAINS_PER_RULE * 5001 }, (_, i) => `d${i}.x.example`), ORIGIN), /too many/);
});

test('priority bands: threat blocks cannot be lifted by adblock/cleaner/pause but yield to policy; bypass lifts only threat', () => {
  assert.ok(PRIORITY_THREAT > PRIORITY_ADBLOCK_ALLOW_ALL && PRIORITY_THREAT > PRIORITY_ADBLOCK_PAUSE && PRIORITY_THREAT > PRIORITY_CLEANER_ALLOW);
  assert.ok(PRIORITY_THREAT < PRIORITY_POLICY_BASE);
  assert.ok(PRIORITY_THREAT_BYPASS > PRIORITY_THREAT && PRIORITY_THREAT_BYPASS < PRIORITY_POLICY_BASE);
  const b = buildBypassRule('bad.example', 7001);
  assert.equal(b.action.type, 'allow');
  assert.deepEqual(b.condition.requestDomains, ['bad.example']);
  assert.ok(b.condition.resourceTypes!.includes('main_frame') && b.condition.resourceTypes!.includes('script'));
  assert.ok(DNR_RULE_THREAT_BASE + 100 * 10_000 > DNR_RULE_THREAT_END, 'list ranges stay inside the threat id space');
});

test('warning URL parsing: only plain http(s) targets, strict list id', () => {
  const ok = parseWarningUrl(`${ORIGIN}/blocked.html?l=urlhaus-online&u=http://evil.example/a?x=1&y=2#frag`);
  assert.equal(ok!.listId, 'urlhaus-online');
  assert.equal(ok!.target.href, 'http://evil.example/a?x=1&y=2#frag');
  for (const bad of [`${ORIGIN}/blocked.html?l=x&u=javascript:alert(1)`, `${ORIGIN}/blocked.html?l=x&u=file:///etc/passwd`, `${ORIGIN}/blocked.html?l=../x&u=http://a.example`, `${ORIGIN}/blocked.html`, `${ORIGIN}/blocked.html?u=http://a.example&l=x`, `${ORIGIN}/blocked.html?l=x&u=`]) {
    assert.equal(parseWarningUrl(bad), null, bad);
  }
});

test('deceptive user-info URLs are matched, normal URLs are not', () => {
  const re = new RegExp(USERINFO_REGEX);
  for (const u of ['https://paypal.com@evil.example/login', 'http://user:pw@host.example/', 'https://www.bank.com:443@evil.example']) assert.ok(re.test(u), u);
  for (const u of ['https://example.com/path@x', 'https://example.com/?email=a@b.c', 'https://example.com#a@b', 'ftp://u@host.example']) assert.ok(!re.test(u), u);
  const rule = compileHeuristicRule(ORIGIN);
  assert.equal(rule.action.redirect!.regexSubstitution, `${ORIGIN}/blocked.html?l=userinfo&u=\\0`);
  // \0 is the whole match: the filter must match the complete URL, otherwise the warning page would get a truncated target
  const whole = 'https://paypal.com@evil.example/login?x=1#f';
  assert.equal(new RegExp(rule.condition.regexFilter!).exec(whole)![0], whole);
});

test('sources: allowlisted https, off by default semantics, attribution and license present', () => {
  assert.ok(THREAT_SOURCES.length >= 3);
  for (const s of THREAT_SOURCES) {
    assert.ok(s.url.startsWith('https://') && s.allowedHosts.includes(new URL(s.url).hostname) && s.format === 'domains' && s.license && s.attribution && s.maxBytes > 0, s.id);
    assert.ok(s.defaultIntervalMs >= 6 * 3600_000);
  }
  assert.equal(getThreatSource('phishing-filter')!.kind, 'phishing');
  assert.equal(new Set(THREAT_SOURCES.map((s) => s.id)).size, THREAT_SOURCES.length);
});

// ---- manager -----------------------------------------------------------------------------------
function listText(n: number, extra = ''): string {
  return ['# Title: T', '# Expires: 12 hours', ...Array.from({ length: n }, (_, i) => `d${i}.threat.example`), extra].join('\n');
}
function mkManager(opts: { body?: () => string; failApply?: () => boolean; budget?: { rules: number; regexRules: number } } = {}) {
  const store = new Map<string, unknown>();
  const installed = new Map<number, unknown[]>();
  const clock = { t: 1_000_000_000 };
  const calls: string[] = [];
  const deps: ThreatManagerDeps = {
    updater: {
      now: () => clock.t, sha256,
      fetch: async (url) => { calls.push(url); const r = new Response(opts.body ? opts.body() : listText(50), { status: 200, headers: { 'content-type': 'text/plain', etag: '"e"' } }); Object.defineProperty(r, 'url', { value: url }); return r; }
    },
    storage: { get: async (k) => store.get(k), set: async (o) => { for (const [k, v] of Object.entries(o)) store.set(k, JSON.parse(JSON.stringify(v))); } },
    extensionOrigin: ORIGIN,
    replaceRules: async (i, rules) => { if (opts.failApply?.()) throw new Error('browser rejected'); installed.set(i, rules); },
    clearRules: async (i) => { installed.delete(i); },
    budget: async () => opts.budget ?? { rules: 1500, regexRules: 500 }
  };
  return { mgr: new ThreatListManager(deps), store, installed, clock, calls };
}
const LEVELS = { malware: 'balanced', phishing: 'balanced' } as const;

test('manager: enabling downloads, validates, installs atomically and records state without storing domains', async () => {
  const m = mkManager();
  const r = await m.mgr.setEnabled('phishing-filter', true);
  assert.deepEqual(r.applied, ['phishing-filter']);
  const idx = THREAT_SOURCES.findIndex((s) => s.id === 'phishing-filter');
  assert.ok(m.installed.get(idx)!.length >= 2);
  const st = (await m.mgr.getStates())['phishing-filter'];
  assert.equal(st.installed, true);
  assert.equal(st.current!.filterCount, 50);
  assert.ok(!JSON.stringify([...m.store.values()]).includes('d1.threat.example'), 'domains are not persisted');
  assert.equal(m.calls[0], getThreatSource('phishing-filter')!.url);
  await m.mgr.setEnabled('phishing-filter', false);
  assert.equal(m.installed.has(idx), false);
  assert.equal((await m.mgr.getStates())['phishing-filter'].installed, false);
});

test('manager guards: shrink, growth, poisoned content, tiny lists, quota, apply failure keep the previous rules', async () => {
  let body = listText(500);
  let fail = false;
  let budget = { rules: 1500, regexRules: 500 };
  const m = mkManager({ body: () => body, failApply: () => fail, budget });
  await m.mgr.setEnabled('phishing-filter', true);
  const idx = THREAT_SOURCES.findIndex((s) => s.id === 'phishing-filter');
  const before = m.installed.get(idx);
  const refresh = async () => { m.clock.t += 6 * 3600_000 + 1; return m.mgr.refresh(LEVELS, { manual: true }); };
  const expectRejected = async (reason: string, make: () => string) => {
    body = make();
    const r = await refresh();
    assert.equal(r.errors['phishing-filter'], reason, reason);
    assert.equal(m.installed.get(idx), before, 'previous rules stay in force');
    assert.equal((await m.mgr.getStates())['phishing-filter'].current!.filterCount, 500);
  };
  await expectRejected('suspicious-shrink', () => listText(100));
  await expectRejected('suspicious-growth', () => listText(5000));
  await expectRejected('no-plausible-entries', () => '# only comments\n\nnotadomain');
  await expectRejected('suspicious-content', () => listText(60) + '\n' + ['google.com', 'mozilla.org', 'github.com', 'microsoft.com', 'apple.com'].join('\n'));
  fail = true;
  body = listText(520);
  assert.equal((await refresh()).errors['phishing-filter'], 'browser rejected');
  assert.equal(m.installed.get(idx), before);
  fail = false;
  const tiny = mkManager({ body: () => listText(300), budget: { rules: 1, regexRules: 500 } });
  assert.equal((await tiny.mgr.setEnabled('phishing-filter', true)).errors['phishing-filter'], 'quota-exceeded');
  assert.equal(tiny.installed.size, 0);
});

test('manager: unchanged content is not reapplied; module level off removes rules, back on requires a fresh download', async () => {
  const m = mkManager();
  await m.mgr.setEnabled('urlhaus-online', true);
  const idx = THREAT_SOURCES.findIndex((s) => s.id === 'urlhaus-online');
  m.clock.t += 6 * 3600_000 + 1;
  const same = await m.mgr.refresh(LEVELS, { manual: true });
  assert.equal(same.outcomes['urlhaus-online'], 'not-modified');
  assert.deepEqual(same.applied, []);
  const off = await m.mgr.applyLevels({ malware: 'off', phishing: 'balanced' });
  assert.deepEqual(off.cleared, ['urlhaus-online']);
  assert.equal(m.installed.has(idx), false);
  assert.equal((await m.mgr.refresh({ malware: 'off', phishing: 'balanced' }, { manual: true })).applied.length, 0, 'off modules are not refreshed');
  const on = await m.mgr.applyLevels(LEVELS);
  assert.equal(on.needsRefresh, true);
  m.clock.t += 6 * 3600_000 + 1;
  assert.deepEqual((await m.mgr.refresh(LEVELS, { manual: true })).applied, ['urlhaus-online']);
  assert.equal(m.installed.has(idx), true);
});

test('manager: unknown lists and corrupt state are handled', async () => {
  const m = mkManager();
  assert.equal((await m.mgr.setEnabled('nope', true)).errors.nope, 'unknown-list');
  m.store.set('threat:states', 'garbage');
  assert.equal((await m.mgr.getStates())['urlhaus-online'].enabled, false);
});
