import test from 'node:test';
import assert from 'node:assert/strict';
import { policyFor, sanitizeSitePolicies, defaultPolicyForLevel, clampGrace, DEFAULT_GRACE_MS, MAX_GRACE_MS } from '../src/protection/storage/model.ts';
import { planCleanup, executeCleanup } from '../src/protection/storage/cleaner.ts';
import type { CookieLike, StorageApi, CleanupContext, OpenTab } from '../src/protection/storage/cleaner.ts';
import { enqueue, cancelFor, due, complete, fail, pruneStale, MAX_ATTEMPTS } from '../src/protection/storage/queue.ts';
import type { CleanupIntent } from '../src/protection/storage/queue.ts';

const ck = (name: string, domain: string, o: Partial<CookieLike> = {}): CookieLike => ({ name, domain, path: '/', secure: false, storeId: 'default', partitionTopLevelSite: null, ...o });

function fakeApi(cookies: CookieLike[], opts: { stubborn?: string[]; dataFails?: boolean; stores?: string[] } = {}) {
  const calls: Array<{ hostnames: string[]; storeId?: string; types: object }> = [];
  const removed: string[] = [];
  const api: StorageApi = {
    async stores() { return opts.stores ?? ['default']; },
    async getCookies(storeId) { return cookies.filter((c) => c.storeId === storeId); },
    async removeCookie(c) {
      if (opts.stubborn?.includes(c.name)) return false;
      const i = cookies.findIndex((x) => x.name === c.name && x.domain === c.domain && x.storeId === c.storeId && (x.partitionTopLevelSite ?? '') === (c.partitionTopLevelSite ?? ''));
      if (i < 0) return false;
      cookies.splice(i, 1); removed.push(`${c.name}@${c.domain}`); return true;
    },
    async removeData(o, types) { if (opts.dataFails) throw new Error('boom'); calls.push({ ...o, types }); }
  };
  return { api, calls, removed, cookies };
}
const ctx = (o: Partial<CleanupContext> = {}): CleanupContext => ({
  sites: {}, fallback: 'ephemeral', openTabs: [], knownHosts: [], cleanCookies: true, cleanData: true, ...o
});
const tab = (host: string, storeId = 'default'): OpenTab => ({ host, storeId });

test('policy resolution: exact > parent > default; public suffixes never match; garbage rejected', () => {
  const sites = sanitizeSitePolicies({ 'example.com': 'persistent', 'shop.example.com': 'ephemeral', 'https://Bank.example.org/x': 'persistent', 'co.uk': 'persistent', nodot: 'persistent', 'bad.test': 'forever' });
  assert.deepEqual(Object.keys(sites).sort(), ['bank.example.org', 'example.com', 'shop.example.com']);
  assert.equal(policyFor('www.example.com', sites, 'session'), 'persistent');
  assert.equal(policyFor('shop.example.com', sites, 'session'), 'ephemeral');
  assert.equal(policyFor('a.shop.example.com', sites, 'session'), 'ephemeral');
  assert.equal(policyFor('example.net', sites, 'session'), 'session');
  assert.equal(policyFor('evil-example.com', sites, 'session'), 'session', 'no suffix confusion');
  assert.equal(policyFor('foo.co.uk', sites, 'session'), 'session', 'public suffix entry rejected');
  assert.equal(defaultPolicyForLevel('balanced'), 'persistent');
  assert.equal(defaultPolicyForLevel('off'), 'persistent');
  assert.equal(defaultPolicyForLevel('strict'), 'session');
  assert.equal(defaultPolicyForLevel('lockdown'), 'ephemeral');
  assert.equal(clampGrace('x'), DEFAULT_GRACE_MS);
  assert.equal(clampGrace(1e12), MAX_GRACE_MS);
  assert.equal(clampGrace(-5), 0);
});

test('plan removes cookies of the site, data per host, and service workers when the site is not open', async () => {
  const f = fakeApi([ck('a', 'example.com'), ck('b', '.example.com'), ck('c', 'www.example.com'), ck('x', 'other.org')]);
  const plan = await planCleanup(f.api, 'example.com', ctx({ knownHosts: ['www.example.com', 'example.com'] }));
  const names = plan.ops.filter((o) => o.kind === 'cookie').map((o) => (o as { cookie: CookieLike }).cookie.name).sort();
  assert.deepEqual(names, ['a', 'b', 'c']);
  const data = plan.ops.find((o) => o.kind === 'data')!;
  assert.deepEqual((data as { hostnames: string[] }).hostnames.sort(), ['example.com', 'www.example.com']);
  assert.ok(plan.ops.some((o) => o.kind === 'serviceWorkers'));
  assert.ok(plan.limitations.some((l) => l.includes('CacheStorage')));
  const res = await executeCleanup(f.api, plan);
  assert.equal(res.cookiesRemoved, 3);
  assert.equal(res.ok, true);
  assert.ok(f.cookies.every((c) => c.domain === 'other.org'), 'other site untouched');
  assert.ok(res.unverified.length >= 1, 'localStorage/IndexedDB cannot be verified and says so');
});

test('persistent hosts are never touched; trusted subdomain blocks service worker removal', async () => {
  const f = fakeApi([ck('a', 'example.com'), ck('t', 'mail.example.com'), ck('u', 'www.example.com')]);
  const c = ctx({ sites: { 'mail.example.com': 'persistent' }, knownHosts: ['mail.example.com', 'www.example.com'] });
  const plan = await planCleanup(f.api, 'example.com', c);
  const names = plan.ops.filter((o) => o.kind === 'cookie').map((o) => (o as { cookie: CookieLike }).cookie.name).sort();
  assert.deepEqual(names, ['a', 'u']);
  const data = plan.ops.find((o) => o.kind === 'data') as { hostnames: string[] };
  assert.ok(!data.hostnames.includes('mail.example.com'));
  assert.ok(!plan.ops.some((o) => o.kind === 'serviceWorkers'), 'hostname removal would also hit the trusted subdomain');
  assert.ok(plan.limitations.some((l) => l.includes('Service Worker')));
  assert.ok(plan.skipped.some((s) => s.code === 'trusted' && s.host === 'mail.example.com'));
  await executeCleanup(f.api, plan);
  assert.ok(f.cookies.some((x) => x.name === 't'));
});

test('a fully persistent site is skipped completely', async () => {
  const f = fakeApi([ck('a', 'bank.example.org')]);
  const plan = await planCleanup(f.api, 'bank.example.org', ctx({ sites: { 'bank.example.org': 'persistent' }, knownHosts: ['bank.example.org'] }));
  assert.equal(plan.ops.length, 0);
  assert.ok(plan.skipped.some((s) => s.code === 'trusted'));
});

test('open tabs protect their container; service workers need the site closed in every container', async () => {
  const f = fakeApi([ck('a', 'example.com', { storeId: 'default' }), ck('b', 'example.com', { storeId: 'box' })], { stores: ['default', 'box'] });
  const plan = await planCleanup(f.api, 'example.com', ctx({ openTabs: [tab('www.example.com', 'default')], knownHosts: ['example.com'] }));
  const cookieOps = plan.ops.filter((o) => o.kind === 'cookie') as Array<{ cookie: CookieLike }>;
  assert.deepEqual(cookieOps.map((o) => o.cookie.storeId), ['box']);
  assert.ok(plan.skipped.some((s) => s.code === 'in-use' && s.storeId === 'default'));
  assert.ok(plan.skipped.some((s) => s.code === 'in-use-other-store'));
  assert.ok(!plan.ops.some((o) => o.kind === 'serviceWorkers'));
  const data = plan.ops.filter((o) => o.kind === 'data') as Array<{ storeId: string }>;
  assert.deepEqual(data.map((d) => d.storeId), ['box'], 'container-scoped data removal');
  // a tab on a different site changes nothing
  const plan2 = await planCleanup(f.api, 'example.com', ctx({ openTabs: [tab('example.net', 'default')], knownHosts: ['example.com'] }));
  assert.equal(plan2.skipped.filter((s) => s.code === 'in-use').length, 0);
  // look-alike domains are not "the same site"
  const plan3 = await planCleanup(f.api, 'example.com', ctx({ openTabs: [tab('notexample.com', 'default')], knownHosts: ['example.com'] }));
  assert.equal(plan3.skipped.filter((s) => s.code === 'in-use').length, 0);
});

test('partitioned cookies: third-party cookies in the site partition go, first-party cookies of the site inside other partitions stay', async () => {
  const f = fakeApi([
    ck('tp', 'tracker.net', { partitionTopLevelSite: 'http://example.com' }),
    ck('tp-other', 'tracker.net', { partitionTopLevelSite: 'http://other.org' }),
    ck('embedded', 'example.com', { partitionTopLevelSite: 'http://other.org' }),
    ck('own', 'example.com')
  ]);
  const plan = await planCleanup(f.api, 'example.com', ctx({ knownHosts: ['example.com'] }));
  const names = plan.ops.filter((o) => o.kind === 'cookie').map((o) => (o as { cookie: CookieLike }).cookie.name).sort();
  assert.deepEqual(names, ['own', 'tp']);
  await executeCleanup(f.api, plan);
  assert.deepEqual(f.cookies.map((c) => c.name).sort(), ['embedded', 'tp-other']);
});

test('persistent top-level site keeps its partitioned third-party cookies', async () => {
  const f = fakeApi([ck('tp', 'tracker.net', { partitionTopLevelSite: 'http://example.com' }), ck('own', 'example.com')]);
  const plan = await planCleanup(f.api, 'example.com', ctx({ sites: { 'example.com': 'persistent' }, knownHosts: ['example.com'] }));
  assert.equal(plan.ops.length, 0);
});

test('module switches: cookies only / data only / nothing', async () => {
  const f = fakeApi([ck('a', 'example.com')]);
  const onlyCookies = await planCleanup(f.api, 'example.com', ctx({ cleanData: false, knownHosts: ['example.com'] }));
  assert.ok(onlyCookies.ops.every((o) => o.kind === 'cookie'));
  const onlyData = await planCleanup(f.api, 'example.com', ctx({ cleanCookies: false, knownHosts: ['example.com'] }));
  assert.ok(onlyData.ops.every((o) => o.kind !== 'cookie') && onlyData.ops.length > 0);
  const none = await planCleanup(f.api, 'example.com', ctx({ cleanCookies: false, cleanData: false }));
  assert.deepEqual(none.skipped, [{ code: 'disabled' }]);
});

test('execution: failures are counted and verified; one failing operation does not stop the others', async () => {
  const f = fakeApi([ck('keep-me', 'example.com'), ck('gone', 'example.com')], { stubborn: ['keep-me'], dataFails: true });
  const plan = await planCleanup(f.api, 'example.com', ctx({ knownHosts: ['example.com'] }));
  const res = await executeCleanup(f.api, plan);
  assert.equal(res.cookiesRemoved, 1);
  assert.equal(res.cookiesFailed, 1);
  assert.equal(res.cookiesRemaining, 1);
  assert.equal(res.ok, false);
  assert.ok(res.dataOps.every((d) => !d.ok));
  // result never contains cookie names or values
  assert.equal(JSON.stringify(res).includes('keep-me'), false);
  assert.equal(JSON.stringify(res).includes('gone'), false);
});

test('cleanup queue: dedupe keeps the earliest due time, cancel on reopen, backoff, give up, prune', () => {
  let q: CleanupIntent[] = [];
  q = enqueue(q, { site: 'a.com', reason: 'tab-closed', dueAt: 1000, createdAt: 1 });
  q = enqueue(q, { site: 'a.com', reason: 'tab-closed', dueAt: 5000, createdAt: 2 });
  assert.equal(q.length, 1);
  assert.equal(q[0].dueAt, 1000);
  q = enqueue(q, { site: 'a.com', storeId: 'box', reason: 'tab-closed', dueAt: 2000, createdAt: 3 });
  assert.equal(q.length, 2);
  assert.deepEqual(due(q, 1500).map((i) => i.site), ['a.com']);
  assert.equal(cancelFor(q, 'a.com', 'box').length, 0, 'store-less intent covers every store and is cancelled too');
  q = enqueue(q, { site: 'a.com', reason: 'manual', dueAt: 0, createdAt: 4 });
  assert.equal(cancelFor(q, 'a.com', 'box').filter((i) => i.reason === 'manual').length, 1, 'manual requests survive cancellation');

  let r = enqueue([], { site: 'b.com', reason: 'startup', dueAt: 0, createdAt: 0 });
  const id = r[0].id;
  for (let i = 0; i < MAX_ATTEMPTS; i++) r = fail(r, id, 10_000, 'x'.repeat(500));
  assert.equal(r[0].attempts, MAX_ATTEMPTS);
  assert.equal(r[0].lastError!.length, 200);
  assert.equal(due(r, 1e12).length, 0, 'given up');
  assert.equal(complete(r, id).length, 0);
  assert.equal(pruneStale(r, 20 * 24 * 3600_000).length, 0);
  const one = enqueue([], { site: 'c.com', reason: 'tab-closed', dueAt: 100, createdAt: 0 });
  assert.equal(fail(one, one[0].id, 0, 'e')[0].dueAt, 60_000);
  assert.equal(fail(fail(one, one[0].id, 0, 'e'), one[0].id, 0, 'e')[0].dueAt, 120_000);
});
