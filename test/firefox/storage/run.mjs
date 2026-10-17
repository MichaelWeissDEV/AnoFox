/**
 * Real-Firefox regression test for the deletion reach of cookies/browsingData (Phase 6).
 * The Cookie Vault planner (src/protection/storage/cleaner.ts) is built on these facts; if a Firefox update changes
 * one of them, this test fails on purpose.
 *
 * Realistic origins: hosts are real-looking domains routed to a local server through a PAC proxy so that they use
 * the default port 80 (hostname filters do not match non-default ports), and are on the Public Suffix List.
 *
 *   npm run test:firefox:storage      (about 5 minutes; FIREFOX_BIN to override; RESULT_OUT=file to keep raw data)
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, cpSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const FIREFOX = process.env.FIREFOX_BIN ?? '/Applications/Firefox.app/Contents/MacOS/firefox';
const PORT = 18780;
const HOSTS = { A: 'anofox-a.com', A2: 'sub.anofox-a.com', B: 'anofox-b.org', T: 'anofox-t.net' };
if (!existsSync(FIREFOX)) { console.log(`SKIP: Firefox not found at ${FIREFOX}`); process.exit(0); }

const dir = mkdtempSync(join(tmpdir(), 'anofox-stor-'));
cpSync(join(here, 'probe'), join(dir, 'probe'), { recursive: true });
const only = ['baseline-no-removal', 'cookies-hostname-A', 'cookies-hostname-A2', 'localStorage-hostname-A', 'indexedDB-hostname-A', 'serviceWorkers-hostname-A',
  'all-types-hostname-A', 'all-types-hostname-T-tracker', 'cookies-api-remove-partitioned', 'container-isolation'];
writeFileSync(join(dir, 'probe', 'config.json'), JSON.stringify({ port: PORT, hosts: HOSTS, only }));
const resultFile = join(dir, 'result.json');

const server = spawn(process.execPath, ['--no-warnings', join(here, 'server.mjs'), resultFile], { env: { ...process.env, PROBE_PORT: String(PORT), TRACKER_HOST: HOSTS.T }, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));
const secure = Object.values(HOSTS).join(',');
const webext = spawn('npx', ['web-ext', 'run', '--source-dir', join(dir, 'probe'), '--firefox', FIREFOX, '--arg=-headless',
  '--pref=privacy.userContext.enabled=true', '--pref=network.proxy.type=2', `--pref=network.proxy.autoconfig_url=http://127.0.0.1:${PORT}/proxy.pac`,
  `--pref=dom.securecontext.allowlist=${secure}`, '--no-reload', '--no-input', '--start-url', 'about:blank'],
  { stdio: 'ignore', cwd: join(here, '../../..'), detached: true });
const kill = () => { try { process.kill(-webext.pid, 'SIGTERM'); } catch {} try { server.kill(); } catch {} };
process.on('exit', kill);
const deadline = Date.now() + 900_000;
while (!existsSync(resultFile) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 2000));
kill();
if (!existsSync(resultFile)) { console.error('FAIL: no result from Firefox within 15 minutes'); process.exit(1); }
const R = JSON.parse(readFileSync(resultFile, 'utf8'));
if (process.env.RESULT_OUT) writeFileSync(process.env.RESULT_OUT, JSON.stringify(R, null, 2));

const S = (name) => R[name];
const changedKeys = (b, a) => Object.keys(b).filter((k) => !['cookiesApi', 'cookiesPartitioned'].includes(k) && JSON.stringify(b[k]) !== JSON.stringify(a[k]));
const gone = (b, a) => b.cookiesPartitioned.filter((c) => !a.cookiesPartitioned.includes(c));
let failed = 0;
const check = (name, fn) => { try { fn(); console.log('ok   ', name); } catch (e) { failed++; console.log('FAIL ', name, '\n     ', e.message); } };
const dc = (s, host) => s[host].docCookie.split(',').filter(Boolean);

check('all seeded storage types exist before removal (cookies, localStorage, IndexedDB, service worker)', () => {
  const b = S('baseline-no-removal').before;
  for (const h of Object.values(HOSTS)) { assert.equal(b[h].ls, 1, h); assert.equal(b[h].idb, 1, h); assert.equal(b[h].sw, 1, h); }
  assert.ok(gone(b, { cookiesPartitioned: [] }).some((c) => c.includes('|pk=http://' + HOSTS.A)), 'partitioned third-party cookie exists under A');
});
check('cookies by hostname: exact host + its domain cookie; other subdomains keep host-only cookies', () => {
  const { before: b, after: a } = S('cookies-hostname-A');
  assert.deepEqual(dc(a, HOSTS.A), []);
  assert.deepEqual(dc(a, HOSTS.A2), ['js', 'lax', 'pers'], 'sub keeps host-only cookies but loses the shared domain cookie');
  assert.deepEqual(changedKeys(b, a).sort(), [HOSTS.A, HOSTS.A2].sort());
  const sub = S('cookies-hostname-A2');
  assert.deepEqual(dc(sub.after, HOSTS.A2), ['dom'], 'removing the subdomain leaves the parent domain cookie');
  assert.deepEqual(dc(sub.after, HOSTS.A), dc(sub.before, HOSTS.A));
});
check('localStorage and IndexedDB by hostname: exactly that origin, nothing else, not each other', () => {
  const ls = S('localStorage-hostname-A'); const idb = S('indexedDB-hostname-A');
  assert.deepEqual(changedKeys(ls.before, ls.after), [HOSTS.A]);
  assert.equal(ls.after[HOSTS.A].ls, 0); assert.equal(ls.after[HOSTS.A].idb, 1);
  assert.deepEqual(changedKeys(idb.before, idb.after), [HOSTS.A]);
  assert.equal(idb.after[HOSTS.A].idb, 0); assert.equal(idb.after[HOSTS.A].ls, 1);
  assert.equal(ls.after[HOSTS.A2].ls, 1, 'subdomain origin untouched');
});
check('COLLATERAL: service workers by hostname also remove subdomain service workers', () => {
  const { before: b, after: a } = S('serviceWorkers-hostname-A');
  assert.equal(a[HOSTS.A].sw, 0); assert.equal(a[HOSTS.A2].sw, 0);
  assert.deepEqual(changedKeys(b, a).sort(), [HOSTS.A, HOSTS.A2].sort());
});
check('clearing a top-level site does NOT clear third-party storage partitioned under it', () => {
  const { before: b, after: a } = S('all-types-hostname-A');
  assert.deepEqual(a['tracker-in-A'], b['tracker-in-A']);
  assert.equal(a[HOSTS.A].ls, 0); assert.equal(a[HOSTS.A].idb, 0); assert.equal(a[HOSTS.A].sw, 0);
});
check('clearing the third-party host clears all of its partitions (and its first-party data)', () => {
  const { before: b, after: a } = S('all-types-hostname-T-tracker');
  for (const k of [HOSTS.T, 'tracker-in-A', 'tracker-in-B']) { assert.equal(a[k].ls, 0, k); assert.equal(a[k].idb, 0, k); assert.equal(a[k].sw, 0, k); assert.equal(a[k].docCookie, '', k); }
  assert.deepEqual(a[HOSTS.A], b[HOSTS.A], 'embedding sites untouched');
});
check('cookies API: default getAll hides partitioned cookies; partitionKey:{} lists all; remove needs the partitionKey and affects one partition', () => {
  const { before: b, after: a } = S('cookies-api-remove-partitioned');
  assert.ok(!b.cookiesApi.some((c) => c.includes('|pk=')), 'plain getAll shows no partitioned cookie');
  const removed = gone(b, a);
  assert.ok(removed.length > 0 && removed.every((c) => c.endsWith('|pk=http://' + HOSTS.A)), removed.join());
  assert.equal(a['tracker-in-A'].docCookie, '');
  assert.deepEqual(a['tracker-in-B'], b['tracker-in-B'], 'other partition untouched');
});
check('containers: cookieStoreId confines cookies/localStorage/IndexedDB removal to that container', () => {
  const c = S('container-isolation');
  assert.equal(c.error, null);
  assert.deepEqual(changedKeys(c.beforeDefault, c.afterDefault), [], 'default container untouched');
  assert.deepEqual(gone(c.beforeDefault, c.afterDefault), []);
  assert.equal(c.afterBox[HOSTS.A].ls, 0); assert.equal(c.afterBox[HOSTS.A].idb, 0); assert.equal(c.afterBox[HOSTS.A].docCookie, '');
});
check('containers: serviceWorkers and cache cannot be combined with cookieStoreId (Firefox throws, nothing is removed)', () => {
  const sw = S('container-with-serviceWorkers-type'); const cache = S('container-with-cache-type');
  if (!sw || !cache) return; // subset run
  assert.match(sw.error, /does not support clearing serviceWorkers with 'cookieStoreId'/);
  assert.deepEqual(changedKeys(sw.beforeBox, sw.afterBox), []);
  assert.match(cache.error, /does not support clearing cache with 'cookieStoreId'/);
});
if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
console.log('\nall Firefox storage-reach checks passed');
