const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let BASE = null;
const log = (m) => { if (BASE) fetch(BASE + '/log?m=' + encodeURIComponent(m)).catch(() => {}); };
const dnr = browser.declarativeNetRequest;

async function nav(url) {
  const t0 = performance.now();
  const tab = await browser.tabs.create({ url, active: true });
  let t = null;
  for (let i = 0; i < 40; i++) {
    await sleep(100);
    t = await browser.tabs.get(tab.id);
    if (t.status === 'complete' && t.url !== 'about:blank') break;
  }
  const ms = Math.round(performance.now() - t0);
  await browser.tabs.remove(tab.id);
  return { ms, url: t && t.url, title: t && t.title };
}
const blocked = (r) => r.title === 'blocked'; // rules redirect to the extension's page, a plain block shows a browser error page that is hard to detect in headless

(async () => {
  try {
    await sleep(1500);
    const cfg = await (await fetch(browser.runtime.getURL('config.json'))).json();
    BASE = cfg.base;
    const res = { limits: {}, sets: {}, enabledAtStart: await dnr.getEnabledRulesets() };
    for (const k of Object.keys(dnr)) if (/MAX|GUARANTEED/.test(k)) res.limits[k] = dnr[k];
    res.availableAtStart = dnr.getAvailableStaticRuleCount ? await dnr.getAvailableStaticRuleCount() : 'n/a';
    res.baseline = await nav('http://clean-1.test/x');

    for (const set of cfg.sets) {
      // make sure nothing else is enabled
      const on = await dnr.getEnabledRulesets();
      if (on.length) await dnr.updateEnabledRulesets({ disableRulesetIds: on });
      const t0 = performance.now();
      let error = null;
      try { await dnr.updateEnabledRulesets({ enableRulesetIds: set.ids }); } catch (e) { error = String(e.message || e); }
      const enableMs = Math.round(performance.now() - t0);
      const out = { ids: set.ids, rules: set.rules, enableMs, error, enabled: await dnr.getEnabledRulesets(), available: dnr.getAvailableStaticRuleCount ? await dnr.getAvailableStaticRuleCount() : 'n/a' };
      if (!error && set.probes) {
        out.probes = {};
        for (const [k, host] of Object.entries(set.probes)) { const r = await nav(`http://${host}/p`); out.probes[k] = { blocked: blocked(r), ms: r.ms, url: r.url }; }
        out.clean = await nav('http://clean-2.test/x');
      }
      res.sets[set.name] = out;
      log(`${set.name}: ${JSON.stringify({ enableMs, error, available: out.available })}`);
    }
    // static + dynamic together
    const on = await dnr.getEnabledRulesets();
    if (on.length) await dnr.updateEnabledRulesets({ disableRulesetIds: on });
    await dnr.updateEnabledRulesets({ enableRulesetIds: [cfg.coexist.static] });
    const dyn = Array.from({ length: 3000 }, (_, i) => ({ id: i + 1, priority: 1, action: { type: 'redirect', redirect: { extensionPath: '/blocked.html' } }, condition: { urlFilter: `||dyn${i}.dynamic.example^`, resourceTypes: ['main_frame'] } }));
    const t1 = performance.now();
    let derr = null;
    try { await dnr.updateDynamicRules({ addRules: dyn }); } catch (e) { derr = String(e.message || e); }
    res.coexist = { dynamicInstallMs: Math.round(performance.now() - t1), error: derr, staticHit: blocked(await nav(`http://${cfg.coexist.staticHost}/p`)), dynamicHit: blocked(await nav('http://dyn2999.dynamic.example/p')) };
    res.coexist.staticHit = res.coexist.staticHit; 
    await fetch(BASE + '/report', { method: 'POST', body: JSON.stringify(res) });
  } catch (e) { log('FATAL ' + e + ' ' + (e && e.stack)); }
})();
