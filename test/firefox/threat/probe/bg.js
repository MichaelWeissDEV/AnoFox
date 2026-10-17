const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let BASE = null;
const log = (m) => { if (BASE) fetch(BASE + '/log?m=' + encodeURIComponent(m)).catch(() => {}); };

async function nav(url) {
  const t0 = performance.now();
  const tab = await browser.tabs.create({ url, active: true });
  let info = null;
  for (let i = 0; i < 40; i++) {
    await sleep(100);
    const t = await browser.tabs.get(tab.id);
    if (t.status === 'complete' && t.url !== 'about:blank') { info = { url: t.url, title: t.title }; break; }
  }
  const ms = Math.round(performance.now() - t0);
  let blocked = null;
  try {
    const [r] = await browser.scripting.executeScript({ target: { tabId: tab.id }, func: () => ({ blocked: document.documentElement.dataset.blocked || null, target: document.documentElement.dataset.target || null, title: document.title }) });
    blocked = r.result;
  } catch (e) { blocked = { error: String(e.message || e) }; }
  await browser.tabs.remove(tab.id);
  return { ms, ...info, ...blocked };
}

function ruleSet(domains, perRule, extUrlBase, idBase = 1) {
  const rules = [];
  for (let i = 0, id = idBase; i < domains.length; i += perRule, id++) {
    rules.push({
      id, priority: 1,
      action: { type: 'redirect', redirect: { regexSubstitution: extUrlBase + '?u=\\0' } },
      condition: { requestDomains: domains.slice(i, i + perRule), regexFilter: '^https?://.*$', resourceTypes: ['main_frame'] }
    });
  }
  return rules;
}
async function install(rules) {
  const ex = await browser.declarativeNetRequest.getDynamicRules();
  const t0 = performance.now();
  let err = null;
  try { await browser.declarativeNetRequest.updateDynamicRules({ removeRuleIds: ex.map((r) => r.id), addRules: rules }); } catch (e) { err = String(e.message || e); }
  return { installMs: Math.round(performance.now() - t0), error: err, rules: rules.length };
}

(async () => {
  try {
    await sleep(1500);
    const cfg = await (await fetch(browser.runtime.getURL('config.json'))).json();
    BASE = cfg.base;
    const ext = browser.runtime.getURL('blocked.html');
    const res = { limits: {}, sets: {} };
    for (const k of Object.keys(browser.declarativeNetRequest)) if (/MAX|GUARANTEED/.test(k)) res.limits[k] = browser.declarativeNetRequest[k];
    res.baselineNav = [await nav('http://clean-1.test/x'), await nav('http://clean-2.test/x')];

    for (const [name, total, per] of [['1x5000', 5000, 5000], ['60x500=30k', 30000, 500], ['800x500=400k', 400000, 500]]) {
      const domains = Array.from({ length: total }, (_, i) => `d${i}.threat-test.example`);
      const rules = ruleSet(domains, per, ext);
      const inst = await install(rules);
      log(`${name}: ${JSON.stringify(inst)}`);
      const probes = { first: domains[0], middle: domains[Math.floor(total / 2)], last: domains[total - 1] };
      const out = { install: inst, hits: {}, misses: {} };
      if (!inst.error) {
        for (const [k, d] of Object.entries(probes)) out.hits[k] = await nav(`http://${d}/path?a=1&b=2#frag`);
        out.hits.subdomain = await nav(`http://sub.${probes.middle}/x`);
        out.hits.ipLikeHostNotListed = await nav('http://1.2.3.4.threat-test.example/x');
        out.misses.unlisted = await nav('http://not-listed.threat-test.example/x');
        out.misses.lookalike = await nav(`http://x${probes.first}.evil.test/x`);
        out.latency = [];
        for (let i = 0; i < 3; i++) out.latency.push((await nav('http://clean-' + i + '.test/x')).ms);
      }
      res.sets[name] = out;
    }
    // IP literals and special hosts
    const ipRules = [{ id: 1, priority: 1, action: { type: 'redirect', redirect: { regexSubstitution: ext + '?u=\\0' } }, condition: { requestDomains: ['10.9.8.7', 'xn--e1afmkfd.xn--p1ai'], regexFilter: '^https?://.*$', resourceTypes: ['main_frame'] } }];
    res.ipAndIdn = { install: await install(ipRules), ip: await nav('http://10.9.8.7/x'), idn: await nav('http://xn--e1afmkfd.xn--p1ai/x') };
    await install([]);
    await fetch(BASE + '/report', { method: 'POST', body: JSON.stringify(res) });
  } catch (e) { log('FATAL ' + e + ' ' + (e && e.stack)); }
})();
