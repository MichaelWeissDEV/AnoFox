import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { LIST_SOURCES, isUrlAllowedForSource, getSource } from '../src/protection/adblock/sources.ts';
import { updateList, newState, clampInterval, parseExpires, MIN_INTERVAL_MS, MAX_INTERVAL_MS, MANUAL_COOLDOWN_MS } from '../src/protection/adblock/updater.ts';
import type { UpdaterDeps, ListState } from '../src/protection/adblock/updater.ts';
import { ListManager } from '../src/protection/adblock/manager.ts';
import type { CompiledRule } from '../src/protection/adblock/compile-dnr.ts';

const source = getSource('easylist')!;
const sha256 = async (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

function listText(n: number, extra = ''): string {
  const lines = ['[Adblock Plus 2.0]', '! Title: Test', '! Version: 202610161200', '! Expires: 4 days'];
  for (let i = 0; i < n; i++) lines.push(`||ads${i}.example^$third-party`);
  lines.push(extra);
  return lines.join('\n');
}

interface Call { url: string; init: RequestInit }
function mkDeps(responder: (c: Call, n: number) => Response | Promise<Response>, clock = { t: 1_000_000_000 }) {
  const calls: Call[] = [];
  const deps: UpdaterDeps = {
    now: () => clock.t, sha256,
    fetch: async (url, init) => { calls.push({ url, init }); return responder({ url, init }, calls.length); }
  };
  return { deps, calls, clock };
}
function resp(body: string | Uint8Array, init: ResponseInit & { url?: string } = {}): Response {
  const { url, ...rest } = init;
  const r = new Response(body, { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8', etag: '"v1"', 'last-modified': 'Fri, 16 Oct 2026 10:00:00 GMT' }, ...rest });
  Object.defineProperty(r, 'url', { value: url ?? source.url });
  return r;
}
const enabled = (s: Partial<ListState> = {}): ListState => ({ ...newState('easylist'), enabled: true, ...s });

test('sources: allowlist, https only, no credentials/ports/foreign hosts', () => {
  assert.ok(LIST_SOURCES.length >= 3);
  for (const s of LIST_SOURCES) assert.ok(isUrlAllowedForSource(s.url, s), s.id);
  assert.equal(isUrlAllowedForSource('http://easylist.to/easylist/easylist.txt', source), false);
  assert.equal(isUrlAllowedForSource('https://evil.example/easylist.txt', source), false);
  assert.equal(isUrlAllowedForSource('https://user:pw@easylist.to/x', source), false);
  assert.equal(isUrlAllowedForSource('https://easylist.to:8443/x', source), false);
  assert.equal(isUrlAllowedForSource('https://easylist.to.evil.example/x', source), false);
  assert.equal(isUrlAllowedForSource('not a url', source), false);
  assert.ok(LIST_SOURCES.every((s) => s.maxBytes > 0 && s.attribution && s.license));
});

test('request is privacy-preserving: no cookies, no referrer, no body, only list URL', async () => {
  const { deps, calls } = mkDeps(() => resp(listText(20)));
  const out = await updateList(source, enabled(), deps);
  assert.equal(out.status, 'updated');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, source.url);
  assert.equal(calls[0].init.credentials, 'omit');
  assert.equal(calls[0].init.referrerPolicy, 'no-referrer');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.body, undefined);
  assert.deepEqual(Object.keys(calls[0].init.headers as object), ['Accept']);
  assert.equal(out.meta?.etag, '"v1"');
  assert.equal(out.meta?.filterCount, 20);
  assert.equal(out.meta?.sha256.length, 64);
  assert.equal(out.meta?.version, '202610161200');
});

test('conditional requests: ETag/Last-Modified sent, 304 keeps list and schedules next check', async () => {
  const clock = { t: 1_000_000_000 };
  const first = mkDeps(() => resp(listText(20)), clock);
  const s1 = (await updateList(source, enabled(), first.deps)).state;
  clock.t += 5 * 24 * 3600_000; // due again
  const second = mkDeps((c) => {
    const h = c.init.headers as Record<string, string>;
    assert.equal(h['If-None-Match'], '"v1"');
    assert.equal(h['If-Modified-Since'], 'Fri, 16 Oct 2026 10:00:00 GMT');
    return new Response(null, { status: 304 });
  }, clock);
  const out = await updateList(source, s1, second.deps);
  assert.equal(out.status, 'not-modified');
  assert.equal(out.state.current?.sha256, s1.current?.sha256);
  assert.ok(out.state.nextCheckAt! > clock.t);
});

test('not due and cooldown: no network access', async () => {
  const clock = { t: 5_000_000_000 };
  const { deps, calls } = mkDeps(() => resp(listText(20)), clock);
  const state = enabled({ lastCheckAt: clock.t - 1000, nextCheckAt: clock.t + 1_000_000 });
  assert.equal((await updateList(source, state, deps)).status, 'not-modified');
  assert.equal((await updateList(source, state, deps, { manual: true })).status, 'cooldown');
  assert.equal((await updateList(source, { ...state, enabled: false }, deps, { manual: true })).status, 'disabled');
  assert.equal(calls.length, 0);
  clock.t += MANUAL_COOLDOWN_MS + 1;
  assert.equal((await updateList(source, state, deps, { manual: true })).status, 'updated');
});

test('bad responses are rejected and the previous list stays', async () => {
  const good = (await updateList(source, enabled(), mkDeps(() => resp(listText(40))).deps)).state;
  assert.ok(good.current);
  const cases: Array<[string, () => Response, string]> = [
    ['redirect to foreign host', () => resp(listText(40), { url: 'https://evil.example/list.txt' }), 'redirect-target-not-allowed'],
    ['html body', () => resp('<html><body>captive portal</body></html>'), 'not-a-filter-list'],
    ['wrong content type', () => resp(listText(40), { headers: { 'content-type': 'text/html' } }), 'unexpected-content-type'],
    ['declared too large', () => resp(listText(40), { headers: { 'content-type': 'text/plain', 'content-length': String(source.maxBytes + 1) } }), 'too-large'],
    ['invalid utf8', () => resp(new Uint8Array([0xff, 0xfe, 0xfd, 0x0a, 0xc3, 0x28])), 'invalid-utf8'],
    ['empty list', () => resp('! only comments\n! nothing'), 'no-plausible-filters'],
    ['suspicious shrink', () => resp(listText(12)), 'suspicious-shrink'],
    ['http error', () => resp('x', { status: 503 }), 'http-503']
  ];
  for (const [name, make, reason] of cases) {
    const { deps } = mkDeps(make);
    const out = await updateList(source, { ...good, nextCheckAt: 0, lastCheckAt: 0 }, deps, { manual: true });
    assert.notEqual(out.status, 'updated', name);
    assert.equal(out.reason, reason, name);
    assert.deepEqual(out.state.current, good.current, name + ' keeps previous list');
    assert.equal(out.state.lastError, reason);
  }
});

test('streaming size cap aborts without content-length', async () => {
  const small = { ...source, maxBytes: 2000 };
  const big = listText(500);
  const stream = new ReadableStream<Uint8Array>({ pull(c) { c.enqueue(new TextEncoder().encode(big)); c.close(); } });
  const r = new Response(stream, { status: 200, headers: { 'content-type': 'text/plain' } });
  Object.defineProperty(r, 'url', { value: source.url });
  const out = await updateList(small, enabled(), mkDeps(() => r).deps);
  assert.equal(out.reason, 'too-large');
});

test('network error and timeout produce error state, never throw', async () => {
  const out = await updateList(source, enabled(), mkDeps(() => { throw new Error('offline'); }).deps);
  assert.equal(out.status, 'error');
  assert.equal(out.reason, 'network');
  const slow: UpdaterDeps = { ...mkDeps(() => resp('')).deps, timeoutMs: 20,
    fetch: (_u, init) => new Promise((_res, rej) => { init.signal!.addEventListener('abort', () => rej(new Error('aborted'))); }) };
  const t = await updateList(source, enabled(), slow);
  assert.equal(t.reason, 'timeout');
});

test('identical content despite 200 is treated as unchanged (no recompile)', async () => {
  const first = await updateList(source, enabled(), mkDeps(() => resp(listText(30))).deps);
  const again = await updateList(source, { ...first.state, nextCheckAt: 0, lastCheckAt: 0 }, mkDeps(() => resp(listText(30))).deps, { manual: true });
  assert.equal(again.status, 'not-modified');
  assert.equal(again.reason, 'same-hash');
});

test('interval helpers', () => {
  assert.equal(clampInterval(1), MIN_INTERVAL_MS);
  assert.equal(clampInterval(1e15), MAX_INTERVAL_MS);
  assert.equal(clampInterval(NaN) > 0, true);
  assert.equal(parseExpires('4 days'), 4 * 24 * 3600_000);
  assert.equal(parseExpires('1 hour'), MIN_INTERVAL_MS); // clamped up
  assert.equal(parseExpires('soon'), undefined);
});

// ---- manager: transactional apply ---------------------------------------------------------
function mkManager(opts: { fail?: () => boolean; budget?: number; fetchBody?: () => Response } = {}) {
  const store = new Map<string, unknown>();
  const applied: CompiledRule[][] = [];
  const clock = { t: 1_000_000_000 };
  const { deps } = mkDeps(opts.fetchBody ?? (() => resp(listText(30))), clock);
  const mgr = new ListManager({
    updater: deps,
    storage: {
      get: async (k) => store.get(k),
      set: async (o) => { for (const [k, v] of Object.entries(o)) store.set(k, JSON.parse(JSON.stringify(v))); },
      remove: async (ks) => { ks.forEach((k) => store.delete(k)); }
    },
    applyRules: async (rules) => { if (opts.fail?.()) throw new Error('browser rejected rules'); applied.push(rules); },
    ruleBudget: async () => opts.budget ?? 1000
  });
  return { mgr, store, applied, clock };
}

test('manager: enabling a list downloads, compiles, applies and persists; disabling removes', async () => {
  const { mgr, store, applied } = mkManager();
  const r = await mgr.setEnabled('easylist', true);
  assert.equal(r.applied, true);
  assert.equal(r.outcomes.easylist, 'updated');
  assert.equal(applied.at(-1)!.length >= 1, true);
  assert.ok(applied.at(-1)!.every((x) => x.id >= 100_000 && x.id <= 199_999));
  assert.ok(store.has('adblock:filters:easylist'));
  assert.equal((await mgr.getStates()).easylist.enabled, true);

  const off = await mgr.setEnabled('easylist', false);
  assert.equal(off.applied, true);
  assert.equal(applied.at(-1)!.length, 0);
  assert.equal(store.has('adblock:filters:easylist'), false);
  assert.equal((await mgr.getStates()).easylist.current, undefined);
});

test('manager: apply failure rolls back to the previous list and keeps state', async () => {
  let failNext = false;
  let version = 30;
  const { mgr, applied, store, clock } = mkManager({ fail: () => failNext, fetchBody: () => resp(listText(version) + `\n! v${version}`) });
  await mgr.setEnabled('easylist', true);
  const before = (await mgr.getStates()).easylist.current!;
  const filtersBefore = JSON.stringify(store.get('adblock:filters:easylist'));
  const appliedCount = applied.length;

  version = 45; failNext = true; clock.t += MANUAL_COOLDOWN_MS + 1;
  const r = await mgr.refresh({ manual: true });
  assert.equal(r.rolledBack, true);
  assert.equal(r.applied, false);
  assert.equal((await mgr.getStates()).easylist.current!.sha256, before.sha256);
  assert.equal(JSON.stringify(store.get('adblock:filters:easylist')), filtersBefore);
  assert.equal(applied.length, appliedCount); // failing apply calls are not recorded; no partial state
});

test('manager: quota from the browser is respected and flagged partial', async () => {
  const { mgr } = mkManager({ budget: 5 });
  const r = await mgr.setEnabled('easylist', true);
  assert.equal(r.stats?.partial, false); // 30 host filters merge into one rule
  const many = mkManager({ budget: 0 });
  const r2 = await many.mgr.setEnabled('easylist', true);
  assert.equal(r2.stats?.partial, true);
  assert.equal(r2.stats?.emitted, 0);
});

test('manager: unknown list ids and corrupt storage are handled', async () => {
  const { mgr, store } = mkManager();
  assert.equal((await mgr.setEnabled('nope', true)).errors.nope, 'unknown-list');
  store.set('adblock:states', { easylist: { id: 'easylist', enabled: 'yes', intervalMs: 'x' } });
  const states = await mgr.getStates();
  assert.equal(typeof states.easylist.intervalMs, 'number');
  store.set('adblock:states', 'garbage');
  assert.equal((await mgr.getStates()).easylist.enabled, false);
});
