let BASE = null;
const log = (m) => { if (BASE) fetch(BASE + '/log?m=' + encodeURIComponent(m)).catch(() => {}); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SETTINGS = [
  ['network', 'networkPredictionEnabled'], ['network', 'peerConnectionEnabled'], ['network', 'webRTCIPHandlingPolicy'],
  ['network', 'httpsOnlyMode'], ['network', 'tlsVersionRestrict'],
  ['services', 'passwordSavingEnabled'],
  ['websites', 'cookieConfig'], ['websites', 'firstPartyIsolate'], ['websites', 'hyperlinkAuditingEnabled'],
  ['websites', 'protectedContentEnabled'], ['websites', 'referrersEnabled'], ['websites', 'resistFingerprinting'],
  ['websites', 'thirdPartyCookiesAllowed'], ['websites', 'trackingProtectionMode']
];
async function load(url) {
  const tab = await browser.tabs.create({ url, active: true });
  await new Promise((resolve) => {
    const l = (id, info) => { if (id === tab.id && info.status === 'complete') { browser.tabs.onUpdated.removeListener(l); resolve(); } };
    browser.tabs.onUpdated.addListener(l);
    setTimeout(resolve, 8000);
  });
  await sleep(1200); // 'complete' can fire for the initial about:blank first
  return tab;
}
async function collect(base) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const fp = await collectOnce(base);
    if (fp && fp.userAgent) return fp;
    log('collect attempt ' + attempt + ' empty, retrying');
  }
  return {};
}
async function collectOnce(base) {
  const tab = await load(base + '/fp.html');
  let r = null;
  for (let i = 0; i < 40 && !r; i++) {
    try {
      const [x] = await browser.scripting.executeScript({ target: { tabId: tab.id }, func: () => (document.documentElement.dataset.fpDone === '1' ? { fp: document.documentElement.dataset.fp, extra: document.documentElement.dataset.fpExtra } : null) });
      r = x.result;
    } catch (e) { if (i === 3) { const t = await browser.tabs.get(tab.id).catch(() => null); log('executeScript failing: ' + e.message + ' tab=' + (t && t.url) + ' status=' + (t && t.status)); } }
    if (!r) await sleep(500);
  }
  if (!r) { log('collect timed out'); r = { fp: '{}', extra: '{}' }; }
  r = { result: r };
  await browser.tabs.remove(tab.id);
  const fp = JSON.parse(r.result.fp || '{}');
  Object.assign(fp, JSON.parse(r.result.extra || '{}'));
  fp.referer = await lastReferer(base);
  return fp;
}
async function lastReferer(base) {
  const refLog = await (await fetch(base + '/ref-log')).json();
  return refLog[refLog.length - 1];
}
async function readAll() {
  const out = {};
  for (const [group, name] of SETTINGS) {
    try {
      const api = browser.privacy[group][name];
      if (!api) { out[`${group}.${name}`] = 'missing'; continue; }
      const g = await api.get({});
      out[`${group}.${name}`] = { value: g.value, levelOfControl: g.levelOfControl };
    } catch (e) { out[`${group}.${name}`] = 'ERR:' + e.message; }
  }
  return out;
}
async function safeClear(api) { try { await api.clear({}); } catch (e) { log('clear failed: ' + e.message); } }
async function trySet(group, name, value) {
  try {
    const api = browser.privacy[group][name];
    await api.set({ value });
    const g = await api.get({});
    return { requested: value, after: g.value, levelOfControl: g.levelOfControl };
  } catch (e) { return { error: String(e.message || e) }; }
}
(async () => { try {
  await sleep(1500);
  const cfg = await (await fetch(browser.runtime.getURL('config.json'))).json();
  const base = cfg.base;
  BASE = base;
  log('start');
  const res = { settingsInitial: await readAll() };
  log('settings read');
  res.baseline = await collect(base);
  log('baseline collected');
  res.set = {};
  res.set.resistFingerprinting = await trySet('websites', 'resistFingerprinting', true);
  await sleep(500);
  res.rfp = await collect(base);
  log('rfp collected');
  res.set.resistFingerprintingOff = await trySet('websites', 'resistFingerprinting', false);
  res.set.referrersEnabled = await trySet('websites', 'referrersEnabled', false);
  await sleep(300);
  res.referrerOff = (await collect(base)).referer;
  await safeClear(browser.privacy.websites.referrersEnabled);
  { const g = await browser.privacy.websites.referrersEnabled.get({}); res.referrersAfterClear = { value: g.value, levelOfControl: g.levelOfControl }; }
  res.set.webRTC = await trySet('network', 'webRTCIPHandlingPolicy', 'disable_non_proxied_udp');
  await sleep(300);
  res.webrtcDisabledUdp = (await collect(base));
  res.set.webRTCDefaultPublic = await trySet('network', 'webRTCIPHandlingPolicy', 'default_public_interface_only');
  res.webrtcPublicOnly = (await collect(base));
  await safeClear(browser.privacy.network.webRTCIPHandlingPolicy);
  res.set.fpi = await trySet('websites', 'firstPartyIsolate', true);
  res.set.tcp = await trySet('websites', 'trackingProtectionMode', 'always');
  await safeClear(browser.privacy.websites.trackingProtectionMode);
  res.set.cookieConfig = await trySet('websites', 'cookieConfig', { behavior: 'reject_third_party', nonPersistentCookies: false });
  await safeClear(browser.privacy.websites.cookieConfig);
  res.set.httpsOnly = await trySet('network', 'httpsOnlyMode', 'always');
  await safeClear(browser.privacy.network.httpsOnlyMode);
  res.set.hyperlinkAuditing = await trySet('websites', 'hyperlinkAuditingEnabled', false);
  await safeClear(browser.privacy.websites.hyperlinkAuditingEnabled);
  await safeClear(browser.privacy.websites.resistFingerprinting);
  res.settingsAfterClear = await readAll();
  await fetch(base + '/report', { method: 'POST', body: JSON.stringify(res) });
} catch (e) { log('ERROR ' + (e && e.message) + ' ' + (e && e.stack)); }
})();
