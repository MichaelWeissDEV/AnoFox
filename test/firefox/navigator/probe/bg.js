const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let BASE = null;
const log = (m) => { if (BASE) fetch(BASE + '/log?m=' + encodeURIComponent(m)).catch(() => {}); };
async function load(url) {
  const tab = await browser.tabs.create({ url, active: true });
  await new Promise((resolve) => {
    const l = (id, info) => { if (id === tab.id && info.status === 'complete') { browser.tabs.onUpdated.removeListener(l); resolve(); } };
    browser.tabs.onUpdated.addListener(l);
    setTimeout(resolve, 8000);
  });
  await sleep(1200);
  return tab;
}
async function readDetect(tab) {
  for (let i = 0; i < 40; i++) {
    try {
      const [x] = await browser.scripting.executeScript({ target: { tabId: tab.id }, func: () => (document.documentElement.dataset.done === '1' ? document.documentElement.dataset.detect : null) });
      if (x.result) return JSON.parse(x.result);
    } catch (e) { /* navigating */ }
    await sleep(500);
  }
  return { error: 'timeout' };
}
async function unregisterAll() {
  const ex = await browser.scripting.getRegisteredContentScripts();
  if (ex.length) await browser.scripting.unregisterContentScripts({ ids: ex.map((s) => s.id) });
}
async function register(file, world) {
  await browser.scripting.registerContentScripts([{ id: 'hook', js: [file], matches: ['http://127.0.0.1/*'], runAt: 'document_start', allFrames: true, matchOriginAsFallback: true, world }]);
}
(async () => {
  try {
    await sleep(1500);
    const cfg = await (await fetch(browser.runtime.getURL('config.json'))).json();
    BASE = cfg.base;
    const results = {};
    const scenarios = [
      ['baseline', null, null],
      ['main-js-getter', 'main-hook.js', 'MAIN'],
      ['main-js-getter+toString-patch', 'main-hook-tostring.js', 'MAIN'],
      ['isolated-xray-exportFunction', 'isolated-hook.js', 'ISOLATED']
    ];
    for (const [name, file, world] of scenarios) {
      try {
        await unregisterAll();
        if (file) await register(file, world);
        const tab = await load(BASE + '/detect.html');
        results[name] = await readDetect(tab);
        await browser.tabs.remove(tab.id);
        log('done ' + name);
      } catch (e) { results[name] = { error: String(e && e.message || e) }; log('ERR ' + name + ' ' + e); }
    }
    await unregisterAll();
    await fetch(BASE + '/report', { method: 'POST', body: JSON.stringify(results) });
  } catch (e) { log('FATAL ' + e); }
})();
