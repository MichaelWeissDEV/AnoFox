/**
 * End-to-end suite for the BUILT AnoFox extension in real (headless) Firefox.
 *
 *   npm run test:e2e        (FIREFOX_BIN to override the Firefox path; RESULT_OUT=file.json keeps the raw result;
 *                            E2E_FILTER='consent hide' runs only checks whose name matches the regex)
 *
 * It builds dist-e2e/ (extension + driver page), starts a virtual-host server, routes the test hostnames to it
 * through a PAC proxy and lets the driver exercise the real background/content scripts. Exit code 1 on any failure.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../../..');
const FIREFOX = process.env.FIREFOX_BIN ?? '/Applications/Firefox.app/Contents/MacOS/firefox';
const PORT = 18790;
if (!existsSync(FIREFOX)) { console.log(`SKIP: Firefox not found at ${FIREFOX}`); process.exit(0); }

const b = spawnSync(process.execPath, ['build.mjs', '--e2e'], { cwd: root, stdio: 'inherit' });
if (b.status !== 0) { console.error('FAIL: e2e build'); process.exit(1); }

const dir = mkdtempSync(join(tmpdir(), 'anofox-e2e-'));
const resultFile = join(dir, 'result.json');
const server = spawn(process.execPath, ['--no-warnings', join(here, 'server.mjs'), resultFile], { env: { ...process.env, PROBE_PORT: String(PORT), E2E_FILTER: process.env.E2E_FILTER ?? '' }, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));
const webext = spawn('npx', ['web-ext', 'run', '--source-dir', join(root, 'dist-e2e'), '--firefox', FIREFOX, '--arg=-headless',
  '--pref=network.proxy.type=2', `--pref=network.proxy.autoconfig_url=http://127.0.0.1:${PORT}/proxy.pac`,
  '--no-reload', '--no-input', '--start-url', 'about:blank'],
  { stdio: 'ignore', cwd: root, detached: true });
const kill = () => { try { process.kill(-webext.pid, 'SIGTERM'); } catch {} try { server.kill(); } catch {} };
process.on('exit', kill);
process.on('SIGINT', () => { kill(); process.exit(130); });

const deadline = Date.now() + 600_000;
while (!existsSync(resultFile) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 1500));
kill();
if (!existsSync(resultFile)) { console.error('FAIL: the driver did not report within 10 minutes'); process.exit(1); }

const { results } = JSON.parse(readFileSync(resultFile, 'utf8'));
if (process.env.RESULT_OUT) writeFileSync(process.env.RESULT_OUT, JSON.stringify(results, null, 2));
let failed = 0;
for (const r of results) {
  if (r.ok) console.log('ok   ', r.name);
  else { failed++; console.log('FAIL ', r.name, '\n     ', r.detail); }
}
console.log(`\n${results.length - failed}/${results.length} end-to-end checks passed`);
process.exit(failed ? 1 : 0);
