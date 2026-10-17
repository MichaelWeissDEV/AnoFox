import test from 'node:test';
import assert from 'node:assert/strict';
import { parseList } from '../src/protection/adblock/parser.ts';
import { CosmeticIndex, isSafeSelector, mandatoryToken, buildCss, hostCandidates, MAX_SELECTORS_PER_INJECTION } from '../src/protection/adblock/cosmetic.ts';
import { compilePolicyRules, PRIORITY_ADBLOCK_PAUSE } from '../src/protection/network/compile.ts';
import { defaultPolicyState } from '../src/core/policy-engine/policy.ts';
import type { UserRule, PolicyState } from '../src/core/policy-engine/policy.ts';
import { PRIORITY_CLEANER } from '../src/dnr-manager.ts';
import { PRIORITY_ADBLOCK_ALLOW_ALL } from '../src/protection/adblock/compile-dnr.ts';

const idx = (text: string) => new CosmeticIndex(parseList(text).cosmetic);

test('selector safety: CSS breakout, comments and unbalanced quoting are rejected', () => {
  for (const ok of ['.ad', '#banner > a', 'div[id^="ad-"]', 'a[href*="x;y"]'.replace(';', '_'), ':is(.a,.b) .c', 'AD-SLOT']) assert.equal(isSafeSelector(ok), true, ok);
  for (const bad of ['.a{color:red}', '.a}body{display:none', '.a;', '/* x */.a', '.a\\0 b', 'a[href="x]', '.a)', '(.a', '.a<!--', '', 'x'.repeat(1001), '.a@import', '.a\n.b']) {
    assert.equal(isSafeSelector(bad), false, JSON.stringify(bad));
  }
});

test('mandatory token extraction ignores :not(), attributes and strings', () => {
  assert.deepEqual(mandatoryToken('.ad-banner'), { kind: 'class', name: 'ad-banner' });
  assert.deepEqual(mandatoryToken('div#AD_300 > a'), { kind: 'id', name: 'AD_300' });
  assert.deepEqual(mandatoryToken('.wrap .ad'), { kind: 'class', name: 'wrap' });
  assert.equal(mandatoryToken('a:not(.x)'), null);
  assert.equal(mandatoryToken('[class^="div-gpt-ad"]'), null);
  assert.equal(mandatoryToken('[data-x=".y"]'), null);
  assert.equal(mandatoryToken('AD-SLOT'), null);
  assert.equal(mandatoryToken('.a\\:b'), null);
});

test('host candidates are suffixes with >= 2 labels', () => {
  assert.deepEqual(hostCandidates('a.b.example.com'), ['a.b.example.com', 'b.example.com', 'example.com']);
  assert.deepEqual(hostCandidates('localhost'), ['localhost']);
});

test('domain-specific, generic, exclusion and exception semantics', () => {
  const i = idx([
    '##.generic-ad', '###sidebar-ad', '##[data-ad-slot]',
    'example.com##.promo', 'example.com,other.org##.promo2',
    '~safe.example.com##.generic-not-on-safe',
    'example.com#@#.generic-ad', 'news.test#@#[data-ad-slot]'
  ].join('\n'));
  // site-specific + always bucket
  assert.deepEqual(i.hostSelectors('www.example.com').sort(), ['.promo', '.promo2', '[data-ad-slot]'].sort());
  assert.deepEqual(i.hostSelectors('other.org').sort(), ['.promo2', '[data-ad-slot]'].sort());
  assert.deepEqual(i.hostSelectors('news.test'), []); // exception removes the always-selector
  assert.deepEqual(i.hostSelectors('notexample.com'), ['[data-ad-slot]']); // no suffix confusion
  // token-driven generics
  assert.deepEqual(i.tokenSelectors('foo.net', { classes: ['generic-ad', 'GENERIC-NOT-ON-SAFE'], ids: ['sidebar-ad'] }).sort(),
    ['#sidebar-ad', '.generic-ad', '.generic-not-on-safe']);
  assert.deepEqual(i.tokenSelectors('example.com', { classes: ['generic-ad'] }), []); // #@# exception
  assert.deepEqual(i.tokenSelectors('safe.example.com', { classes: ['generic-not-on-safe'] }), []); // ~domain exclusion
  assert.deepEqual(i.tokenSelectors('foo.net', { classes: ['unknown'], ids: [] }), []);
});

test('unsafe selectors never enter the index; css has one rule per selector and only display:none', () => {
  const i = new CosmeticIndex([
    { exception: false, selector: '.ok', domains: [], excludedDomains: [] },
    { exception: false, selector: '.bad{color:red}', domains: [], excludedDomains: [] },
    { exception: false, selector: '.bad2', domains: ['x.test'], excludedDomains: [] }
  ]);
  assert.equal(i.stats.rejected, 1);
  const css = buildCss(['.ok', '.bad{x}', '#b > a']);
  assert.equal(css, '.ok{display:none!important}\n#b > a{display:none!important}');
  assert.equal(buildCss(['}']), '');
  const many = Array.from({ length: MAX_SELECTORS_PER_INJECTION + 50 }, (_, n) => `.c${n}`);
  assert.equal(buildCss(many).split('\n').length, MAX_SELECTORS_PER_INJECTION);
});

test('unsupported cosmetic syntax never reaches the index', () => {
  const r = parseList(['example.com##+js(abort-on-property-read, x)', 'example.com#?#div:has(> .ad)', 'example.com##div:has-text(Ad)', 'example.com##.a{x:y}', 'example.com##.fine'].join('\n'));
  assert.equal(r.cosmetic.length, 1);
  assert.equal(new CosmeticIndex(r.cosmetic).hostSelectors('example.com')[0], '.fine');
});

const pause = (o: Partial<UserRule> = {}): UserRule => ({
  id: 'p1', module: 'adblock', effect: 'allow', scope: { kind: 'site', site: 'example.org' }, duration: 'permanent', createdAt: 1, ...o
});
const st = (rules: UserRule[]): PolicyState => ({ ...defaultPolicyState(), rules });

test('adblock pause compiles to allowAllRequests below policy bands and above list rules', () => {
  const c = compilePolicyRules(st([pause()]));
  assert.equal(c.dynamic.length, 1);
  const r = c.dynamic[0];
  assert.equal(r.action.type, 'allowAllRequests');
  assert.equal(r.priority, PRIORITY_ADBLOCK_PAUSE);
  assert.deepEqual(r.condition.requestDomains, ['example.org']);
  assert.deepEqual(r.condition.resourceTypes, ['main_frame', 'sub_frame']);
  assert.ok(PRIORITY_ADBLOCK_PAUSE > PRIORITY_ADBLOCK_ALLOW_ALL);
  assert.ok(PRIORITY_ADBLOCK_PAUSE < 20);
  assert.ok(PRIORITY_CLEANER > PRIORITY_ADBLOCK_PAUSE, 'pausing adblock must not disable the URL cleaner');
});

test('adblock pause durations and unsupported shapes', () => {
  const s = compilePolicyRules(st([pause({ duration: 'session' }), pause({ id: 'p2', duration: 'tab', tabId: 4 })]));
  assert.equal(s.session.length, 2);
  assert.deepEqual(s.session[1].condition.tabIds, [4]);
  assert.equal(s.dynamic.length, 0);
  const bad = compilePolicyRules(st([
    pause({ id: 'g', scope: { kind: 'global' } }), pause({ id: 'b', effect: 'block' }), pause({ id: 't', target: 'x.example' }), pause({ id: 'o', duration: 'once' })
  ]));
  assert.equal(bad.dynamic.length + bad.session.length, 0);
  assert.deepEqual(bad.unsupported.map((u) => u.ruleId).sort(), ['b', 'g', 'o', 't']);
  const off = compilePolicyRules({ ...st([pause()]), profile: 'custom', customLevels: { ...defaultPolicyState().customLevels, adblock: 'off' } });
  assert.equal(off.dynamic.length, 0);
});
