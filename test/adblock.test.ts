import test from 'node:test';
import assert from 'node:assert/strict';
import { parseList, parseLine, summarizeUnsupported } from '../src/protection/adblock/parser.ts';
import type { NetworkFilter } from '../src/protection/adblock/parser.ts';
import { compileFilters, PRIORITY_ADBLOCK, PRIORITY_ADBLOCK_IMPORTANT } from '../src/protection/adblock/compile-dnr.ts';
import type { CompiledRule } from '../src/protection/adblock/compile-dnr.ts';
import { PRIORITY_POLICY_BASE } from '../src/protection/network/compile.ts';
import { registrableDomain } from '../src/core/domain-utils/domains.ts';

const net = (line: string): NetworkFilter => {
  const p = parseLine(line, 1);
  assert.ok(p && p.kind === 'network', `expected network filter: ${line} -> ${JSON.stringify(p)}`);
  return p;
};
const unsupported = (line: string) => {
  const p = parseLine(line, 1);
  assert.ok(p && p.kind === 'unsupported', `expected unsupported: ${line} -> ${JSON.stringify(p)}`);
  return p.reason;
};

test('parses ABP network filters: patterns, exceptions, options', () => {
  const f = net('||ads.example.com^$third-party,script,image,domain=a.com|~b.a.com');
  assert.deepEqual(f.pattern, { type: 'urlFilter', value: '||ads.example.com^' });
  assert.equal(f.domainType, 'thirdParty');
  assert.deepEqual(f.resourceTypes?.sort(), ['image', 'script']);
  assert.deepEqual(f.initiatorDomains, ['a.com']);
  assert.deepEqual(f.excludedInitiatorDomains, ['b.a.com']);
  assert.equal(f.exception, false);

  const e = net('@@||cdn.example.com/lib.js$~third-party,xhr');
  assert.equal(e.exception, true);
  assert.equal(e.domainType, 'firstParty');
  assert.deepEqual(e.resourceTypes, ['xmlhttprequest']);

  const n = net('/banner/*/img^$~image,~media');
  assert.deepEqual(n.excludedResourceTypes?.sort(), ['image', 'media']);

  assert.equal(net('||x.com^$important').important, true);
  assert.equal(net('||x.com^$match-case').matchCase, true);
  assert.equal(net('@@||x.com^$document').allowAll, true);
  assert.deepEqual(net('$script,3p').resourceTypes, ['script']);
});

test('regex filters: safe ones accepted, RE2-incompatible rejected explicitly', () => {
  const ok = net('/ads[0-9]+\\.js/');
  assert.deepEqual(ok.pattern, { type: 'regex', value: 'ads[0-9]+\\.js' });
  assert.equal(unsupported('/(?=ad)banner/'), 'pattern:regex-unsafe');
  assert.equal(unsupported('/(a)\\1/'), 'pattern:regex-unsafe');
});

test('unsupported syntax is reported with specific reasons, never mistranslated', () => {
  assert.equal(unsupported('||x.com^$redirect=noopjs'), 'option:redirect');
  assert.equal(unsupported('||x.com^$removeparam=utm'), 'option:removeparam');
  assert.equal(unsupported('||x.com^$csp=script-src none'), 'option:csp');
  assert.equal(unsupported('||x.com^$popup'), 'option:popup');
  assert.equal(unsupported('||x.com^$denyallow=y.com'), 'option:denyallow');
  assert.equal(unsupported('||x.com^$frobnicate'), 'option:unknown');
  assert.equal(unsupported('||x.com^$domain=google.*'), 'domain:entity');
  assert.equal(unsupported('||bücher.de^'), 'pattern:non-ascii');
  assert.equal(unsupported('example.com##+js(abort-on-property-read, foo)'), 'scriptlet');
  assert.equal(unsupported('example.com#?#div:has(> .ad)'), 'procedural-cosmetic');
  assert.equal(unsupported('example.com##div:has-text(Ad)'), 'procedural-cosmetic');
  assert.equal(unsupported('example.com##^script:has-text(x)'), 'procedural-cosmetic');
});

test('cosmetic filters: plain selectors are classified, not executed', () => {
  const r = parseList('##.banner-ad\nexample.com,~sub.example.com##div#sidebar-ad\nexample.org#@#.keep\n');
  assert.equal(r.cosmetic.length, 3);
  assert.deepEqual(r.cosmetic[0].domains, []);
  assert.deepEqual(r.cosmetic[1].domains, ['example.com']);
  assert.deepEqual(r.cosmetic[1].excludedDomains, ['sub.example.com']);
  assert.equal(r.cosmetic[2].exception, true);
  assert.equal(parseList('example.com##a{display:none}').cosmetic.length, 0);
});

test('comments, metadata, hosts and domain-list formats', () => {
  const r = parseList('[Adblock Plus 2.0]\n! Title: Test\n! Expires: 4 days\n! comment\n\n||a.example^\n');
  assert.equal(r.filters.length, 1);
  assert.equal(r.metadata.title, 'Test');
  assert.equal(r.ignored, 6); // incl. trailing empty line
  const h = parseList('# hosts\n127.0.0.1 localhost\n0.0.0.0 tracker.example # c\n::1 ip6-localhost\n', 'hosts');
  assert.deepEqual(h.filters.map((f) => f.pattern?.value), ['||tracker.example^']);
  const d = parseList('bad.example\nnot a domain\n', 'domains');
  assert.equal(d.filters.length, 1);
  assert.equal(d.unsupported.length, 1);
  assert.deepEqual(summarizeUnsupported(parseList('||a.com^$popup\n||b.com^$popup\n').unsupported), { 'option:popup': 2 });
});

test('compiler maps options to DNR conditions and priorities', () => {
  const f = [
    net('||ads.example.com^path$third-party,script,domain=a.com'),
    net('@@||ads.example.com^path$script'),
    net('||evil.example^path$important'),
    net('@@||news.example^$document'),
    net('||media.example^$match-case')
  ];
  const { rules, stats } = compileFilters(f, { idBase: 1, maxRules: 100 });
  assert.equal(stats.emitted, 5);
  const block = rules.find((r) => r.condition.urlFilter === '||ads.example.com^path' && r.action.type === 'block')!;
  assert.equal(block.priority, PRIORITY_ADBLOCK);
  assert.equal(block.condition.domainType, 'thirdParty');
  assert.deepEqual(block.condition.initiatorDomains, ['a.com']);
  assert.equal(rules.find((r) => r.condition.urlFilter === '||evil.example^path')!.priority, PRIORITY_ADBLOCK_IMPORTANT);
  const all = rules.find((r) => r.action.type === 'allowAllRequests')!;
  assert.deepEqual(all.condition.resourceTypes, ['main_frame', 'sub_frame']);
  assert.equal(rules.find((r) => r.condition.urlFilter === '||media.example^')!.condition.isUrlFilterCaseSensitive, true);
  // adblock bands must stay below policy bands
  assert.ok(Math.max(...rules.map((r) => r.priority)) < PRIORITY_POLICY_BASE);
  assert.equal(new Set(rules.map((r) => r.id)).size, rules.length);
});

test('badfilter cancels its target; duplicates removed', () => {
  const f = [net('||a.example^$script'), net('||a.example^$script,badfilter'), net('||b.example^'), net('||b.example^')];
  const { rules, stats } = compileFilters(f, { idBase: 1, maxRules: 10 });
  assert.equal(stats.badfiltered, 2);
  assert.equal(stats.duplicates, 1);
  assert.equal(rules.length, 1);
});

test('regexes the browser rejects are reported, not emitted', () => {
  const { rules, stats, rejected } = compileFilters([net('/ads[0-9]+/'), net('||ok.example^')], {
    idBase: 1, maxRules: 10, regexSupported: () => false
  });
  assert.equal(rules.length, 1);
  assert.equal(stats.regexRejected, 1);
  assert.equal(rejected[0].reason, 'regex-not-supported-by-browser');
});

test('quota: exceptions are kept, blocks truncated, result flagged partial', () => {
  const f: NetworkFilter[] = [];
  for (let i = 0; i < 10; i++) f.push(net(`||t${i}.example/p$script`));
  f.push(net('@@||ok.example/p$script'));
  const { rules, stats } = compileFilters(f, { idBase: 1, maxRules: 4 });
  assert.equal(rules.length, 4);
  assert.equal(stats.partial, true);
  assert.equal(stats.truncated, 7);
  assert.ok(rules.some((r) => r.action.type === 'allow'));
});

// --- semantic equivalence of the host-grouping optimisation --------------------------------
function matches(r: CompiledRule, url: string, type: string, top: string): boolean {
  const u = new URL(url);
  const c = r.condition;
  if (c.resourceTypes ? !c.resourceTypes.includes(type as never) : type === 'main_frame') return false;
  if (c.excludedResourceTypes?.includes(type as never)) return false;
  if (c.domainType === 'thirdParty' && registrableDomain(top) === registrableDomain(u.hostname)) return false;
  if (c.domainType === 'firstParty' && registrableDomain(top) !== registrableDomain(u.hostname)) return false;
  if (c.initiatorDomains && !c.initiatorDomains.some((d) => top === d || top.endsWith('.' + d))) return false;
  if (c.excludedInitiatorDomains?.some((d) => top === d || top.endsWith('.' + d))) return false;
  if (c.requestDomains && !c.requestDomains.some((d) => u.hostname === d || u.hostname.endsWith('.' + d))) return false;
  if (c.urlFilter) {
    const m = c.urlFilter.match(/^\|\|([a-z0-9.-]+)\^$/);
    if (!m) throw new Error('test model supports only ||host^ filters: ' + c.urlFilter);
    if (!(u.hostname === m[1] || u.hostname.endsWith('.' + m[1]))) return false;
  }
  return true;
}
function verdict(rules: CompiledRule[], url: string, type: string, top: string): 'allow' | 'block' {
  const m = rules.filter((r) => matches(r, url, type, top));
  if (!m.length) return 'allow';
  const top_ = Math.max(...m.map((r) => r.priority));
  const best = m.filter((r) => r.priority === top_);
  return best.some((r) => r.action.type !== 'block') ? 'allow' : 'block';
}

test('host grouping (requestDomains) is equivalent to one rule per filter', () => {
  const lines = [
    '||a.example^', '||b.example^', '||c.example^$third-party', '||d.example^$third-party', '||e.example^$script',
    '||f.example^$script', '@@||b.example^', '||g.example^$important', '@@||g.example^', '||h.example^$domain=news.test',
    '||i.example^$domain=news.test', '@@||sub.a.example^'
  ];
  const filters = lines.map(net);
  const grouped = compileFilters(filters, { idBase: 1, maxRules: 100 });
  const single = compileFilters(filters, { idBase: 1, maxRules: 100, maxDomainsPerRule: 1 });
  assert.ok(grouped.rules.length < single.rules.length);
  const hosts = ['a', 'sub.a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'z'].map((x) => `${x}.example`);
  for (const h of hosts) for (const type of ['script', 'image', 'sub_frame']) for (const top of ['news.test', 'x.example', 'other.org']) {
    const url = `https://${h}/p`;
    assert.equal(verdict(grouped.rules, url, type, top), verdict(single.rules, url, type, top), `${h} ${type} ${top}`);
  }
  // spot checks of ABP semantics
  assert.equal(verdict(grouped.rules, 'https://b.example/', 'image', 'other.org'), 'allow'); // exception wins
  assert.equal(verdict(grouped.rules, 'https://g.example/', 'image', 'other.org'), 'block'); // important wins
  assert.equal(verdict(grouped.rules, 'https://sub.a.example/', 'image', 'other.org'), 'allow');
  assert.equal(verdict(grouped.rules, 'https://a.example/', 'image', 'other.org'), 'block');
});
