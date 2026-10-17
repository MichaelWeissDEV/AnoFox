// Data-driven probe: config.json = { base, scenarios: [{ name, path, rules }] }.
// Applies the given DNR rules as dynamic rules, loads the page, reads the result from the DOM.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function setDnr(rules) {
  const ex = await browser.declarativeNetRequest.getDynamicRules();
  await browser.declarativeNetRequest.updateDynamicRules({ removeRuleIds: ex.map((r) => r.id), addRules: rules });
}

async function load(url) {
  const tab = await browser.tabs.create({ url, active: true });
  await new Promise((resolve) => {
    const l = (id, info) => { if (id === tab.id && info.status === 'complete') { browser.tabs.onUpdated.removeListener(l); resolve(); } };
    browser.tabs.onUpdated.addListener(l);
    setTimeout(resolve, 6000);
  });
  await sleep(1200);
  return tab;
}

async function read(tab) {
  const out = await browser.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true },
    func: () => ({
      path: location.pathname, title: document.title,
      bodyBg: document.body ? getComputedStyle(document.body).backgroundColor : null,
      data: Object.assign({}, document.documentElement.dataset)
    })
  });
  return out.map((o) => o.result);
}

(async () => {
  await sleep(1500);
  const cfg = await (await fetch(browser.runtime.getURL('config.json'))).json();
  const results = {};
  for (const sc of cfg.scenarios) {
    try {
      await setDnr(sc.rules);
      const tab = await load(cfg.base + sc.path);
      results[sc.name] = await read(tab);
      await browser.tabs.remove(tab.id);
    } catch (e) {
      results[sc.name] = { error: String((e && e.message) || e) };
    }
  }
  await setDnr([]);
  await fetch(cfg.base + '/report', { method: 'POST', body: JSON.stringify(results) });
})();
