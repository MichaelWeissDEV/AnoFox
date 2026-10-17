/**
 * Feasibility/detectability study for JS-level navigator normalization (Phase 5.3) in real Firefox.
 * Three hook techniques are installed via scripting.registerContentScripts and compared against a baseline with
 * a detection page. The assertions document the CURRENT behaviour, in particular the known limits that led to the
 * decision NOT to ship navigator spoofing (docs/architecture/fingerprinting-normalization.md). If a Firefox update
 * changes one of these facts, this test fails on purpose so the decision gets re-evaluated.
 *
 *   npm run test:firefox:navigator
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, cpSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const FIREFOX = process.env.FIREFOX_BIN ?? '/Applications/Firefox.app/Contents/MacOS/firefox';
const PORT = 18779;
if (!existsSync(FIREFOX)) { console.log(`SKIP: Firefox not found at ${FIREFOX}`); process.exit(0); }

const dir = mkdtempSync(join(tmpdir(), 'anofox-nav-'));
cpSync(join(here, 'probe'), join(dir, 'probe'), { recursive: true });
writeFileSync(join(dir, 'probe', 'config.json'), JSON.stringify({ base: `http://127.0.0.1:${PORT}` }));
const resultFile = join(dir, 'result.json');
const server = spawn(process.execPath, ['--no-warnings', join(here, 'server.mjs'), resultFile], { env: { ...process.env, PROBE_PORT: String(PORT) }, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));
const webext = spawn('npx', ['web-ext', 'run', '--source-dir', join(dir, 'probe'), '--firefox', FIREFOX, '--arg=-headless', '--no-reload', '--no-input', '--start-url', 'about:blank'],
  { stdio: 'ignore', cwd: join(here, '../../..'), detached: true });
const kill = () => { try { process.kill(-webext.pid, 'SIGTERM'); } catch {} try { server.kill(); } catch {} };
process.on('exit', kill);
const deadline = Date.now() + 240_000;
while (!existsSync(resultFile) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 1000));
kill();
if (!existsSync(resultFile)) { console.error('FAIL: no result from Firefox within 4 minutes'); process.exit(1); }
const R = JSON.parse(readFileSync(resultFile, 'utf8'));
if (process.env.RESULT_OUT) writeFileSync(process.env.RESULT_OUT, JSON.stringify(R, null, 2));

let failed = 0;
const check = (name, fn) => { try { fn(); console.log('ok   ', name); } catch (e) { failed++; console.log('FAIL ', name, '\n     ', e.message); } };
const B = R.baseline;
const hooks = ['main-js-getter', 'main-js-getter+toString-patch', 'isolated-xray-exportFunction'];
const wk = (s, which) => JSON.parse(R[s][which]);

check('baseline is native: getter toString shows [native code], wrong receiver throws TypeError', () => {
  assert.match(B['getter.toString'], /\[native code\]/);
  assert.match(B['getter.wrongReceiver'], /^ERR:TypeError/);
});
check('all hook techniques run before the first page script and cover about:blank and srcdoc iframes', () => {
  for (const h of hooks) {
    assert.equal(R[h]['early.hw'], '4', h);
    assert.equal(R[h]['iframe.blank.sync'], '4', h);
    assert.equal(JSON.parse(R[h]['iframe.srcdoc']).hw, 4, h);
  }
});
check('KNOWN LIMIT: dedicated workers (blob and file) are NOT covered by any technique', () => {
  for (const h of hooks) for (const w of ['worker.blob', 'worker.file']) {
    const v = wk(h, w);
    assert.equal(v.hw, Number(B.hw), `${h} ${w} still reports the real hardwareConcurrency`);
    assert.equal(v.platform, B.platform, `${h} ${w} still reports the real platform`);
    assert.notEqual(R[h].hw, String(v.hw), `${h}: page and worker disagree`);
  }
});
check('KNOWN LIMIT: HTTP User-Agent / Accept-Language headers disagree with the spoofed JS values', () => {
  for (const h of hooks) { assert.equal(R[h].uaVsHeader, 'false', h); assert.equal(R[h].uaHeader, B.uaHeader, h); }
  assert.notEqual(R['main-js-getter'].languages, B.languages);
  assert.equal(R['main-js-getter'].acceptLanguageHeader, B.acceptLanguageHeader);
});
check('DETECTABLE: plain MAIN-world getter leaks its source and name', () => {
  assert.match(R['main-js-getter']['getter.toString'], /return value/);
  assert.equal(R['main-js-getter']['getter.name'], 'get');
});
check('DETECTABLE: toString patching hides the source but a wrong receiver no longer throws', () => {
  assert.match(R['main-js-getter+toString-patch']['getter.toString'], /\[native code\]/);
  assert.equal(R['main-js-getter+toString-patch']['getter.name'], B['getter.name']);
  assert.doesNotMatch(R['main-js-getter+toString-patch']['getter.wrongReceiver'], /^ERR:TypeError/);
});
check('DETECTABLE: Xray exportFunction getter has an empty name and does not throw on a wrong receiver', () => {
  assert.equal(R['isolated-xray-exportFunction']['getter.name'], '');
  assert.notEqual(R['isolated-xray-exportFunction']['getter.toString'], B['getter.toString']);
  assert.doesNotMatch(R['isolated-xray-exportFunction']['getter.wrongReceiver'], /^ERR:TypeError/);
});
if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
console.log('\nall checks passed (they document why navigator spoofing is not shipped)');
