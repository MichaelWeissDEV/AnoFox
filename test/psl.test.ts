import test from 'node:test';
import assert from 'node:assert/strict';
import { registrableDomain, publicSuffix, isPublicSuffix, isThirdParty, hostMatches, normalizeHost, sanitizeDomainList } from '../src/core/domain-utils/domains.ts';
import { PSL_NORMAL, PSL_WILDCARD, PSL_EXCEPTION, PSL_VERSION } from '../src/core/domain-utils/psl-data.ts';

test('generated data: version, plausible rule counts, ASCII only', () => {
  assert.match(PSL_VERSION, /^\d{4}-\d{2}-\d{2}/);
  const normal = PSL_NORMAL.split(' ');
  assert.ok(normal.length > 9000 && PSL_WILDCARD.split(' ').length > 200 && PSL_EXCEPTION.split(' ').length >= 1);
  for (const r of ['com', 'co.uk', 'github.io', 'blogspot.com']) assert.ok(normal.includes(r), r);
  assert.ok(PSL_EXCEPTION.split(' ').includes('www.ck'));
  assert.ok(/^[\x00-\x7f]*$/.test(PSL_NORMAL + PSL_WILDCARD + PSL_EXCEPTION), 'rules are punycode');
  assert.ok(normal.some((r) => r.startsWith('xn--')), 'IDN suffixes present as punycode');
});

test('PSL algorithm: normal, wildcard, exception, private and default rules', () => {
  const cases: Array<[string, string, string]> = [
    // host, public suffix, registrable domain
    ['example.com', 'com', 'example.com'],
    ['www.example.com', 'com', 'example.com'],
    ['a.b.example.co.uk', 'co.uk', 'example.co.uk'],
    ['foo.bar.ck', 'bar.ck', 'foo.bar.ck'], // *.ck
    ['www.ck', 'ck', 'www.ck'], // !www.ck
    ['a.www.ck', 'ck', 'www.ck'],
    ['a.github.io', 'github.io', 'a.github.io'], // private section
    ['x.y.github.io', 'github.io', 'y.github.io'],
    ['foo.blogspot.com', 'blogspot.com', 'foo.blogspot.com'],
    ['a.b.unknowntld', 'unknowntld', 'b.unknowntld'], // default rule "*"
    ['EXAMPLE.COM.', 'com', 'example.com']
  ];
  for (const [host, suffix, reg] of cases) {
    assert.equal(publicSuffix(host), suffix.toLowerCase(), `suffix of ${host}`);
    assert.equal(registrableDomain(host), reg, `registrable of ${host}`);
  }
});

test('hosts that are suffixes, IPs and single labels are returned unchanged', () => {
  for (const h of ['co.uk', 'github.io', 'com', 'localhost', '127.0.0.1', '10.9.8.7', '[::1]']) assert.equal(registrableDomain(h), h, h);
  assert.equal(isPublicSuffix('co.uk'), true);
  assert.equal(isPublicSuffix('github.io'), true);
  assert.equal(isPublicSuffix('com'), true);
  assert.equal(isPublicSuffix('example.co.uk'), false);
  assert.equal(isPublicSuffix('127.0.0.1'), false);
});

test('IDN input is converted to punycode everywhere', () => {
  assert.equal(normalizeHost('Bücher.DE'), 'xn--bcher-kva.de');
  assert.equal(registrableDomain('www.bücher.de'), 'xn--bcher-kva.de');
  assert.deepEqual(sanitizeDomainList(['https://Bücher.de/x', 'shop.example.com']), ['xn--bcher-kva.de', 'shop.example.com']);
});

test('third-party and host matching follow site boundaries, not string suffixes', () => {
  assert.equal(isThirdParty('www.example.co.uk', 'cdn.example.co.uk'), false);
  assert.equal(isThirdParty('a.github.io', 'b.github.io'), true);
  assert.equal(isThirdParty('example.com', 'example.org'), true);
  assert.equal(hostMatches('foo.example.com', 'example.com'), true);
  assert.equal(hostMatches('evil-example.com', 'example.com'), false);
  assert.equal(hostMatches('x.github.io', 'github.io'), false, 'a public suffix never matches as an exception entry');
  assert.equal(hostMatches('x.co.uk', 'co.uk'), false);
  assert.equal(hostMatches('shop.bank.co.uk', 'bank.co.uk'), true);
  assert.equal(hostMatches('a.com', 'com'), false);
});

test('lookups are fast enough for per-request use', () => {
  const t0 = performance.now();
  for (let i = 0; i < 50_000; i++) registrableDomain(`sub${i % 50}.example${i % 997}.co.uk`);
  assert.ok(performance.now() - t0 < 1500, `took ${Math.round(performance.now() - t0)} ms`);
});
