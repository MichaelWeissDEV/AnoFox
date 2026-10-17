import { build } from 'esbuild';
import { cp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';

// `node build.mjs`          -> dist/       (the extension)
// `node build.mjs --e2e`    -> dist-e2e/   (same extension + test driver page, used only by test/firefox/e2e)
const e2e = process.argv.includes('--e2e');
const outdir = e2e ? 'dist-e2e' : 'dist';

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

await build({
  entryPoints: [
    'src/background.ts',
    'src/popup.ts',
    'src/options.ts',
    'src/content-embed-guard.ts',
    'src/content-cosmetic.ts',
    'src/content-consent.ts'
  ],
  outdir,
  bundle: true,
  format: 'iife',
  target: 'es2022'
});

await cp('public', outdir, { recursive: true });

if (e2e) {
  await build({ entryPoints: ['test/firefox/e2e/driver.ts'], outfile: `${outdir}/e2e-driver.js`, bundle: true, format: 'iife', target: 'es2022' });
  await cp('test/firefox/e2e/driver.html', `${outdir}/e2e-driver.html`);
  // test-only boot script (e2e build only): opens the driver page once the background is up
  // (the event page restarts whenever it was idle; boot exactly once per browser session)
  await writeFile(`${outdir}/e2e-boot.js`, "(async () => { const f = await browser.storage.session.get('e2eBooted'); if (f.e2eBooted) return; await browser.storage.session.set({ e2eBooted: true }); setTimeout(() => browser.tabs.create({ url: browser.runtime.getURL('e2e-driver.html') }), 1500); })();\n");
  const manifest = JSON.parse(await readFile(`${outdir}/manifest.json`, 'utf8'));
  manifest.background.scripts = [...manifest.background.scripts, 'e2e-boot.js'];
  await writeFile(`${outdir}/manifest.json`, JSON.stringify(manifest, null, 2));
}
