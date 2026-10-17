const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let BASE_PORT = null;
const log = (m) => { if (BASE_PORT) fetch(`http://127.0.0.1:${BASE_PORT}/log?m=` + encodeURIComponent(m)).catch(() => {}); };
let A, A2, B, T;
const url = (h, p) => `http://${h}${p}`; // port 80 via PAC proxy: origins must look like real sites

async function visit(u, { storeId, flag = 'ready', read = (f) => f } = {}) {
  const tab = await browser.tabs.create({ url: u, active: true, ...(storeId ? { cookieStoreId: storeId } : {}) });
  let out = null;
  for (let i = 0; i < 40 && out === null; i++) {
    await sleep(400);
    try {
      const [x] = await browser.scripting.executeScript({ target: { tabId: tab.id }, func: (flag) => (document.documentElement.dataset[flag] === '1' ? { ...document.documentElement.dataset } : null), args: [flag] });
      out = x.result;
    } catch (e) { /* navigating */ }
  }
  await sleep(flag === 'seeded' ? 1500 : 200); // let embedded frames finish
  await browser.tabs.remove(tab.id);
  return out;
}
const parse = (d, k) => { try { return d && d[k] ? JSON.parse(d[k]) : null; } catch { return null; } };

async function seedAll(storeId) {
  await visit(url(A, '/seed.html?embed=1'), { storeId, flag: 'seeded' });
  await visit(url(A2, '/seed.html'), { storeId, flag: 'seeded' });
  await visit(url(B, '/seed.html?embed=1'), { storeId, flag: 'seeded' });
  await visit(url(T, '/seed.html'), { storeId, flag: 'seeded' });
}
async function snapshot(storeId) {
  const s = {};
  for (const h of [A, A2, B, T]) s[h] = parse(await visit(url(h, '/state.html'), { storeId }), 'state');
  s['tracker-in-A'] = parse(await visit(url(A, '/frame-state.html'), { storeId }), 'tracker');
  s['tracker-in-B'] = parse(await visit(url(B, '/frame-state.html'), { storeId }), 'tracker');
  const all = await browser.cookies.getAll({ ...(storeId ? { storeId } : {}) });
  let part = [];
  try { part = await browser.cookies.getAll({ partitionKey: {}, ...(storeId ? { storeId } : {}) }); } catch (e) { part = ['ERR ' + e.message]; }
  s.cookiesPartitioned = part.map((c) => (typeof c === 'string' ? c : `${c.name}@${c.domain}|pk=${c.partitionKey && c.partitionKey.topLevelSite}`)).sort();
  s.cookiesApi = all.map((c) => `${c.name}@${c.domain}${c.partitionKey ? '|pk=' + c.partitionKey.topLevelSite : ''}|${c.session ? 's' : 'p'}${c.httpOnly ? 'H' : ''}`).sort();
  return s;
}
async function resetAll() {
  await browser.browsingData.remove({}, { cookies: true, localStorage: true, indexedDB: true, serviceWorkers: true, cache: true });
  const cs = await browser.cookies.getAll({});
  for (const c of cs) { try { await browser.cookies.remove({ url: `http://${c.domain.replace(/^\./, '')}${c.path}`, name: c.name, storeId: c.storeId, ...(c.partitionKey ? { partitionKey: c.partitionKey } : {}) }); } catch (e) {} }
}

const results = {};
let ONLY = null;
async function variant(name, remove, opts = {}) {
  if (ONLY && !ONLY.includes(name)) return;
  try {
    await resetAll();
    await seedAll(opts.storeId);
    const before = await snapshot(opts.storeId);
    let err = null;
    try { await remove(); } catch (e) { err = String(e && e.message || e); }
    await sleep(500);
    const after = await snapshot(opts.storeId);
    results[name] = { before, after, error: err };
    log('done ' + name);
  } catch (e) { results[name] = { error: String(e && e.message || e) }; log('ERR ' + name + ' ' + e); }
}

(async () => {
  try {
    await sleep(1500);
    const cfg = await (await fetch(browser.runtime.getURL('config.json'))).json();
    BASE_PORT = cfg.port; ({ A, A2, B, T } = cfg.hosts); ONLY = cfg.only || null;
    results.settings = await browser.browsingData.settings();
    results.cookieStores = await browser.cookies.getAllCookieStores();
    const bd = (hostnames, types, extra = {}) => () => browser.browsingData.remove({ hostnames, ...extra }, types);
    const ALL = { cookies: true, localStorage: true, indexedDB: true, serviceWorkers: true };
    await variant('baseline-no-removal', async () => {});
    await variant('cookies-hostname-A', bd([A], { cookies: true }));
    await variant('cookies-hostname-A2', bd([A2], { cookies: true }));
    await variant('localStorage-hostname-A', bd([A], { localStorage: true }));
    await variant('indexedDB-hostname-A', bd([A], { indexedDB: true }));
    await variant('serviceWorkers-hostname-A', bd([A], { serviceWorkers: true }));
    await variant('all-types-hostname-A', bd([A], ALL));
    await variant('all-types-hostname-A2-subdomain-only', bd([A2], ALL));
    await variant('all-types-hostname-T-tracker', bd([T], ALL));
    await variant('no-hostname-localStorage-only', () => browser.browsingData.remove({}, { localStorage: true }));
    await variant('cookies-api-remove-partitioned', async () => {
      const part = await browser.cookies.getAll({ partitionKey: {} });
      results.partitionedBefore = part.map((c) => `${c.name}@${c.domain}|pk=${c.partitionKey && c.partitionKey.topLevelSite}`);
      const out = [];
      for (const c of part) {
        if (c.partitionKey && c.partitionKey.topLevelSite.includes('anofox-a')) {
          const r = await browser.cookies.remove({ url: `http://${c.domain.replace(/^\./, '')}${c.path}`, name: c.name, storeId: c.storeId, partitionKey: c.partitionKey });
          out.push(r ? r.name : null);
        }
      }
      results.partitionedRemoveReturn = out;
    });
    // containers: isolation. Seed default AND container, remove in the container only.
    let cid = null;
    try {
      const ci = await browser.contextualIdentities.create({ name: 'probe', color: 'blue', icon: 'fingerprint' });
      cid = ci.cookieStoreId; results.container = cid;
    } catch (e) { results.container = 'ERR ' + e.message; }
    const containerTest = async (name, types) => {
      try {
        await resetAll();
        await seedAll(undefined);
        await seedAll(cid);
        const beforeDefault = await snapshot(undefined);
        const beforeBox = await snapshot(cid);
        let err = null;
        try { await browser.browsingData.remove({ hostnames: [A], cookieStoreId: cid }, types); } catch (e) { err = String(e.message || e); }
        await sleep(500);
        results[name] = { error: err, beforeDefault, beforeBox, afterDefault: await snapshot(undefined), afterBox: await snapshot(cid) };
        log('done ' + name);
      } catch (e) { results[name] = { error: String(e) }; }
    };
    if (cid && (!ONLY || ONLY.includes('container-isolation'))) {
      await containerTest('container-isolation', { cookies: true, localStorage: true, indexedDB: true });
      await containerTest('container-with-serviceWorkers-type', { serviceWorkers: true });
      await containerTest('container-with-cache-type', { cache: true });
    }
    await fetch(`http://127.0.0.1:${BASE_PORT}/report`, { method: 'POST', body: JSON.stringify(results) });
  } catch (e) { log('FATAL ' + e + ' ' + (e && e.stack)); }
})();
