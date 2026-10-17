/**
 * Real-Firefox probe of the native privacy APIs AnoFox relies on (Phase 5).
 * Loads a probe extension into headless Firefox, reads/sets browser.privacy.* settings and measures the effect
 * with a local fingerprint test page.
 *
 *   npm run test:firefox:privacy         (FIREFOX_BIN to override; RESULT_OUT=file.json to keep the raw result)
 *
 * Note: headless Firefox reports some synthetic values (window/screen size); only invariants are asserted.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, cpSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const FIREFOX = process.env.FIREFOX_BIN ?? '/Applications/Firefox.app/Contents/MacOS/firefox';
const PORT = 18778;
if (!existsSync(FIREFOX)) { console.log(`SKIP: Firefox not found at ${FIREFOX}`); process.exit(0); }

const dir = mkdtempSync(join(tmpdir(), 'anofox-priv-'));
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

check('privacy API present with levelOfControl for the settings AnoFox uses', () => {
  for (const k of ['websites.resistFingerprinting', 'network.webRTCIPHandlingPolicy', 'websites.referrersEnabled', 'network.networkPredictionEnabled', 'websites.trackingProtectionMode', 'websites.hyperlinkAuditingEnabled']) {
    assert.ok(R.settingsInitial[k]?.levelOfControl, k + ' ' + JSON.stringify(R.settingsInitial[k]));
  }
});
check('resistFingerprinting can be enabled and becomes controlled_by_this_extension', () => {
  assert.deepEqual([R.set.resistFingerprinting.after, R.set.resistFingerprinting.levelOfControl], [true, 'controlled_by_this_extension']);
});
check('RFP effect: UTC offset 0, different canvas result, generic WebGL renderer', () => {
  assert.equal(R.rfp.tzOffset, '0');
  assert.notEqual(R.rfp.canvas, R.baseline.canvas);
  assert.equal(JSON.parse(R.rfp.webgl).renderer, 'Mozilla');
});
check('referrersEnabled=false removes the Referer header', () => {
  assert.ok(R.baseline.referer, 'baseline has a referer');
  assert.equal(R.referrerOff, null);
});
check('WebRTC policy reduces ICE candidates and leaks no IP literal', () => {
  assert.ok(Number(R.webrtcDisabledUdp.rtcCount) < Number(R.baseline.rtcCount), `${R.webrtcDisabledUdp.rtcCount} < ${R.baseline.rtcCount}`);
  assert.equal(R.webrtcDisabledUdp.rtcHasIpLiteral, false);
  assert.equal(R.baseline.rtcHasIpLiteral, false, 'Firefox default already hides host IPs behind mDNS names');
});
check('clear() releases control (set(default) would not)', () => {
  assert.equal(R.referrersAfterClear.levelOfControl, 'controllable_by_this_extension');
  assert.equal(R.settingsAfterClear['websites.resistFingerprinting'].levelOfControl, 'controllable_by_this_extension');
  assert.equal(R.settingsAfterClear['websites.resistFingerprinting'].value, false);
});
console.log('\ninfo  firstPartyIsolate:', JSON.stringify(R.set.fpi));
console.log('info  httpsOnlyMode:', JSON.stringify(R.set.httpsOnly), '| thirdPartyCookiesAllowed:', R.settingsInitial['websites.thirdPartyCookiesAllowed']);
if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
console.log('\nall Firefox privacy checks passed');
