/**
 * Real-Firefox regression test for the CSP-based script control (Phase 4).
 *
 * Starts a local test server, loads a probe extension into headless Firefox (via web-ext) and feeds it the
 * DNR rules that AnoFox's own compiler produces. Asserts what the browser actually executes.
 *
 *   npm run test:firefox:csp            (FIREFOX_BIN=/path/to/firefox to override)
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, cpSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { compilePolicyRules, CSP_INLINE_STRICT, CSP_INLINE_LOCKDOWN } from '../../../src/protection/network/compile.ts';
import { defaultPolicyState, PROFILE_LEVELS } from '../../../src/core/policy-engine/policy.ts';

const here = dirname(fileURLToPath(import.meta.url));
const FIREFOX = process.env.FIREFOX_BIN ?? '/Applications/Firefox.app/Contents/MacOS/firefox';
const PORT = 18777;
const BASE = `http://127.0.0.1:${PORT}`;
const HOST = '127.0.0.1';

if (!existsSync(FIREFOX)) { console.log(`SKIP: Firefox not found at ${FIREFOX}`); process.exit(0); }

const rulesOf = (state) => {
  const c = compilePolicyRules({ ...defaultPolicyState(), ...state });
  assert.equal(c.session.length, 0);
  return c.dynamic;
};
const rule = (o) => ({ id: 'r' + Math.random().toString(36).slice(2), module: 'inline', effect: 'allow', scope: { kind: 'site', site: HOST }, duration: 'permanent', createdAt: 1, ...o });
const raw = (id, value, extra = {}) => ({
  id, priority: 20, action: { type: 'modifyHeaders', responseHeaders: [{ header: 'content-security-policy', operation: 'append', value }] },
  condition: { requestDomains: [HOST], resourceTypes: ['main_frame', 'sub_frame'], ...extra }
});
const customStrictInline = { profile: 'custom', customLevels: { ...PROFILE_LEVELS.balanced, inline: 'strict' } };

const scenarios = [
  { name: 'baseline', path: '/page.html', rules: [] },
  { name: 'compiled-lockdown', path: '/page.html', rules: rulesOf({ profile: 'lockdown' }) },
  { name: 'compiled-lockdown-with-site-exception', path: '/page.html', rules: rulesOf({ profile: 'lockdown', rules: [
    rule({ module: 'inline' }), rule({ module: 'scripts' })] }) },
  { name: 'compiled-lockdown-inline-exception-only', path: '/page.html', rules: rulesOf({ profile: 'lockdown', rules: [rule({ module: 'inline' })] }) },
  { name: 'compiled-lockdown-other-site-exception', path: '/page.html', rules: rulesOf({ profile: 'lockdown', rules: [
    rule({ module: 'inline', scope: { kind: 'site', site: 'example.org' } })] }) },
  { name: 'compiled-strict-inline', path: '/page.html', rules: rulesOf(customStrictInline) },
  { name: 'compiled-strict-inline-probe', path: '/probe.html', rules: rulesOf(customStrictInline) },
  { name: 'compiled-site-block-under-lenient-profile', path: '/page.html', rules: rulesOf({ profile: 'custom', customLevels: { ...PROFILE_LEVELS.balanced, inline: 'balanced' }, rules: [rule({ effect: 'block' })] }) },
  { name: 'compiled-lockdown-subframe', path: '/frame-host.html', rules: rulesOf({ profile: 'lockdown' }) },
  { name: 'own-csp-plus-lockdown', path: '/page-own-csp.html', rules: [raw(1, CSP_INLINE_LOCKDOWN)] },
  { name: 'own-csp-plus-strict', path: '/page-own-csp.html', rules: [raw(1, CSP_INLINE_STRICT)] }
];

const dir = mkdtempSync(join(tmpdir(), 'anofox-csp-'));
cpSync(join(here, 'probe'), join(dir, 'probe'), { recursive: true });
writeFileSync(join(dir, 'probe', 'config.json'), JSON.stringify({ base: BASE, scenarios }));
const resultFile = join(dir, 'result.json');

const server = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', join(here, 'server.mjs'), resultFile], { env: { ...process.env, PROBE_PORT: String(PORT) }, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));
const webext = spawn('npx', ['web-ext', 'run', '--source-dir', join(dir, 'probe'), '--firefox', FIREFOX, '--arg=-headless', '--no-reload', '--no-input', '--start-url', 'about:blank'], { stdio: 'ignore', cwd: join(here, '../../..'), detached: true });
const kill = () => { try { process.kill(-webext.pid, 'SIGTERM'); } catch {} try { server.kill(); } catch {} };
process.on('exit', kill);

const deadline = Date.now() + 180_000;
while (!existsSync(resultFile) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 1000));
kill();
if (!existsSync(resultFile)) { console.error('FAIL: no result from Firefox within 3 minutes'); process.exit(1); }
const R = JSON.parse(readFileSync(resultFile, 'utf8'));

const top = (name) => R[name]?.find((f) => f.path !== '/page.html' || R[name].length === 1) ?? R[name]?.[0];
const frame = (name, path) => R[name]?.find((f) => f.path === path);
const ran = (title, what) => title.split(' ').includes(what);
let failed = 0;
const check = (name, fn) => { try { fn(); console.log('ok   ', name); } catch (e) { failed++; console.log('FAIL ', name, '\n     ', e.message); } };

check('baseline: everything runs', () => {
  const t = R.baseline[0].title;
  for (const w of ['inline-ran', 'ext-ran', 'handler-ran', 'inline-module-ran']) assert.ok(ran(t, w), w + ' / ' + t);
});
check('lockdown profile: no script of any kind runs', () => assert.equal(R['compiled-lockdown'][0].title, 'start'));
check('lockdown + site exception (scripts and inline): all run again', () => {
  const t = R['compiled-lockdown-with-site-exception'][0].title;
  for (const w of ['inline-ran', 'ext-ran', 'handler-ran', 'inline-module-ran']) assert.ok(ran(t, w), w + ' / ' + t);
});
check('lockdown + inline exception only: inline/handlers run, external script still blocked by the scripts module', () => {
  const t = R['compiled-lockdown-inline-exception-only'][0].title;
  assert.ok(ran(t, 'inline-ran') && ran(t, 'handler-ran'), t);
  assert.ok(!ran(t, 'ext-ran'), t);
});
check('exception for another site does not unlock this one', () => assert.equal(R['compiled-lockdown-other-site-exception'][0].title, 'start'));
check('strict inline: inline script, handlers and inline modules blocked; external script runs', () => {
  const t = R['compiled-strict-inline'][0].title;
  assert.equal(t, 'start ext-ran');
});
check('strict inline: eval/Function/wasm blocked; cross-origin import and blob workers allowed', () => {
  const d = R['compiled-strict-inline-probe'][0].data;
  const p = JSON.parse(d.probe);
  assert.equal(p.eval, 'ERR:EvalError');
  assert.equal(p.Function, 'ERR:EvalError');
  assert.equal(p['wasm-sync'], 'ERR:CompileError');
  assert.equal(d.crossImport, 'ok');
  assert.equal(d.workerOk, '1');
  assert.equal(d.dynInline, undefined);
});
check('site-level block under a lenient profile blocks that site', () => assert.equal(R['compiled-site-block-under-lenient-profile'][0].title, 'start'));
check('sub_frame documents get the CSP too (host page still runs its own inline script only where allowed)', () => {
  const f = R['compiled-lockdown-subframe'];
  assert.equal(f.find((x) => x.path === '/frame-host.html').title, 'host');
  assert.equal(f.find((x) => x.path === '/page.html').title, 'start');
});
check('appended CSP never weakens a page CSP and intersects with it (own CSP allows inline; ours removes it)', () => {
  assert.equal(R['own-csp-plus-lockdown'][0].title, 'start');
  assert.equal(R['own-csp-plus-strict'][0].title, 'start ext-ran');
});

if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
console.log('\nall Firefox CSP checks passed');
