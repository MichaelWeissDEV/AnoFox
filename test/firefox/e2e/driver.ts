/**
 * End-to-end driver. Runs inside the REAL built AnoFox extension (extension page in headless Firefox), talks to the
 * background through the same runtime messages the popup and options page use, loads pages from a local virtual-host
 * server and verifies what the browser actually did (request log = ground truth for "blocked before the network").
 */
import { parseList } from '../../../src/protection/adblock/parser.ts';

const SERVER = 'http://127.0.0.1:18790';
const A = 'anofox-a.com';
const B = 'anofox-b.org';
const T = 'anofox-t.net';

interface CheckResult { name: string; ok: boolean; detail?: string }
const results: CheckResult[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const send = async (msg: Record<string, unknown>): Promise<any> => { void ping('> ' + String(msg.type)); const r = await sendRaw(msg); void ping('< ' + String(msg.type)); return r; };
const sendRaw = async (msg: Record<string, unknown>): Promise<any> => Promise.race([
  browser.runtime.sendMessage(msg),
  new Promise((_, rej) => setTimeout(() => rej(new Error(`message ${String(msg.type)} timed out after 20s`)), 20000))
]);

function ping(m: string) { return pingImpl(m); }
const pingImpl = (m: string) => fetch(`${SERVER}/__ping?m=${encodeURIComponent(m)}`).catch(() => undefined);
ping('driver loaded');
let networkMode = false; // set from the server: E2E_NETWORK=1 -> only "download:" checks, with real internet access
let filter: RegExp | null = null; // optional E2E_FILTER=regex: only run matching checks (fast iteration)
async function check(name: string, fn: () => Promise<string | void> | string | void): Promise<void> {
  if (networkMode !== name.startsWith('download:')) return; // download: checks need (and only run with) real network access
  if (filter && !filter.test(name)) return;
  try {
    const note = await Promise.race([Promise.resolve().then(fn), new Promise<never>((_, rej) => setTimeout(() => rej(new Error('check timed out after 90s')), 90_000))]);
    results.push({ name, ok: true, detail: typeof note === 'string' ? note : undefined }); await ping('ok ' + name);
  }
  catch (e) { results.push({ name, ok: false, detail: String((e as Error)?.message ?? e).slice(0, 500) }); await ping('FAIL ' + name + ' :: ' + String((e as Error)?.message ?? e).slice(0, 200)); }
}
function assert(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
function eq<T>(actual: T, expected: T, what: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

async function serverLog(): Promise<Array<{ host: string; url: string }>> { return (await fetch(`${SERVER}/__log`)).json(); }
async function serverReset(): Promise<void> { await fetch(`${SERVER}/__reset`); }
const requested = (log: Array<{ host: string; url: string }>, host: string, pathPrefix: string): boolean => log.some((r) => r.host === host && r.url.startsWith(pathPrefix));

async function openTab(url: string, storeId?: string): Promise<browser.tabs.Tab> {
  const tab = await browser.tabs.create({ url, active: true, ...(storeId ? { cookieStoreId: storeId } : {}) });
  await new Promise<void>((resolve) => {
    const l = (id: number, info: browser.tabs._OnUpdatedChangeInfo) => { if (id === tab.id && info.status === 'complete') { browser.tabs.onUpdated.removeListener(l); resolve(); } };
    browser.tabs.onUpdated.addListener(l);
    setTimeout(resolve, 8000);
  });
  await sleep(700);
  return tab;
}
async function run<R>(tabId: number, func: (...a: any[]) => R, args: unknown[] = []): Promise<R> {
  for (let i = 0; i < 20; i++) {
    try { const [r] = await browser.scripting.executeScript({ target: { tabId }, func, args: args as never }); return r.result as R; }
    catch { await sleep(300); }
  }
  throw new Error('executeScript failed repeatedly');
}
async function waitUntil(tabId: number, func: (...a: any[]) => unknown, args: unknown[] = [], timeoutMs = 8000): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { if (await run(tabId, func, args).catch(() => false)) return true; await sleep(250); }
  return false;
}
async function titleOf(tabId: number): Promise<string> { return run(tabId, () => document.title); }
async function withTab<R>(url: string, fn: (tab: browser.tabs.Tab) => Promise<R>): Promise<R> {
  const tab = await openTab(url);
  try { return await fn(tab); } finally { await browser.tabs.remove(tab.id!).catch(() => undefined); }
}
async function reset(): Promise<void> { await send({ type: 'RESET_SETTINGS' }); await serverReset(); }
const words = (title: string) => title.split(' ').filter(Boolean);

async function seedList(text: string): Promise<void> {
  const parsed = parseList(text);
  await browser.storage.local.set({
    'adblock:states': { easylist: { id: 'easylist', enabled: false, intervalMs: 4 * 24 * 3600_000, current: { sha256: 'e'.repeat(64), fetchedAt: Date.now(), bytes: text.length, filterCount: parsed.filters.length, unsupportedCount: 0, cosmeticCount: parsed.cosmetic.length } } },
    'adblock:filters:easylist': parsed.filters.map(({ raw: _r, ...rest }) => rest),
    'adblock:cosmetic:easylist': parsed.cosmetic.map(({ raw: _r, line: _l, kind: _k, ...rest }) => rest)
  });
  const r = await send({ type: 'SET_LIST_ENABLED', id: 'easylist', enabled: true });
  assert(r?.success, 'list could not be activated: ' + JSON.stringify(r));
}

async function main(): Promise<void> {
  const f = await (await fetch(`${SERVER}/__filter`)).text().catch(() => '');
  if (f) filter = new RegExp(f, 'i');
  networkMode = (await (await fetch(`${SERVER}/__network`)).text().catch(() => '')) === '1';
  // ---------------------------------------------------------------- startup
  await check('startup: background answers with schema v2 defaults (balanced, nothing enabled that should not be)', async () => {
    for (let i = 0; i < 20; i++) { const r = await send({ type: 'GET_SETTINGS' }).catch(() => null); if (r?.success) { eq(r.settings.schemaVersion, 2, 'schema'); eq(r.settings.profile, 'balanced', 'profile'); return; } await sleep(300); }
    throw new Error('background did not answer');
  });

  // ---------------------------------------------------------------- URL tracking cleaner
  await reset();
  await check('URL cleaner: tracking parameters are removed BEFORE the request, other parameters stay', async () => {
    await withTab(`http://${A}/clean?utm_source=nl&fbclid=abc&id=42&utm_campaign=x`, async () => undefined);
    const log = await serverLog();
    eq(log.filter((r) => r.url.startsWith('/clean')).map((r) => r.url), ['/clean?id=42'], 'what the server received');
  });
  await check('URL cleaner: signed / auth URLs are left untouched', async () => {
    await serverReset();
    await withTab(`http://${A}/clean?code=abc123&state=zz&utm_source=x`, async () => undefined);
    eq((await serverLog()).filter((r) => r.url.startsWith('/clean')).map((r) => r.url), ['/clean?code=abc123&state=zz&utm_source=x'], 'auth URL');
  });
  await check('URL cleaner: per-site exception disables cleaning for that site only', async () => {
    await send({ type: 'TOGGLE_EXCEPTION', domain: A });
    await serverReset();
    await withTab(`http://${A}/clean?utm_source=keep`, async () => undefined);
    await withTab(`http://${B}/clean?utm_source=drop`, async () => undefined);
    const urls = (await serverLog()).filter((r) => r.url.startsWith('/clean'));
    assert(urls.some((r) => r.host === A && r.url === '/clean?utm_source=keep'), 'exception site must keep its parameter');
    assert(urls.some((r) => r.host === B && r.url === '/clean'), 'other site is cleaned: ' + JSON.stringify(urls));
  });

  // ---------------------------------------------------------------- Social embed guard

  await check('permissions: no declarativeNetRequestFeedback; cleaned-URL counting follows the OPTIONAL webRequest permission, cleaning itself never does', async () => {
    const granted = await browser.permissions.contains({ permissions: ['webRequest'] });
    const mf = browser.runtime.getManifest();
    assert(!(mf.permissions ?? []).includes('declarativeNetRequestFeedback'), 'declarativeNetRequestFeedback must not be requested');
    await reset();
    await send({ type: 'UPDATE_SETTINGS', settings: { statsEnabled: true } });
    await serverReset();
    await withTab(`http://${A}/clean?utm_source=a&id=1`, async () => { await sleep(1500); });
    eq((await serverLog()).filter((r) => r.url.startsWith('/clean')).map((r) => r.url), ['/clean?id=1'], 'the URL is cleaned either way');
    const st = await send({ type: 'GET_STATS_AND_LOGS' });
    if (granted) assert(st.statistics.totalCleanedUrls >= 1, 'permission granted but nothing counted: ' + JSON.stringify(st.statistics));
    else eq(st.statistics.totalCleanedUrls, 0, 'without the permission nothing can be counted (and nothing may crash)');
  });
  await reset();
  await check('Embed Guard: Twitch embed is blocked before the network and replaced by a placeholder', async () => {
    await withTab(`http://${A}/embed.html`, async (tab) => {
      const ok = await waitUntil(tab.id!, () => [...document.querySelectorAll('*')].some((e) => (e as HTMLElement).shadowRoot && (e as HTMLElement).shadowRoot!.textContent!.includes('Twitch')));
      assert(ok, 'no placeholder with provider name found');
    });
    assert(!requested(await serverLog(), 'player.twitch.tv', '/'), 'blocked embed must never reach the server');
  });
  await check('Embed Guard: a per-site exception lets the embed load', async () => {
    await send({ type: 'TOGGLE_EMBED_EXCEPTION', domain: A });
    await serverReset();
    await withTab(`http://${A}/embed.html`, async () => { await sleep(1000); });
    assert(requested(await serverLog(), 'player.twitch.tv', '/'), 'exception site must load the embed');
  });
  await check('Embed Guard: the exception is bound to the embedding site, other sites stay protected', async () => {
    await serverReset();
    await withTab(`http://${B}/embed.html`, async () => { await sleep(1000); });
    assert(!requested(await serverLog(), 'player.twitch.tv', '/'), 'site B has no exception');
  });
  await check('Embed Guard: switching the module off loads embeds everywhere', async () => {
    await send({ type: 'UPDATE_SETTINGS', settings: { socialEmbedsEnabled: false } });
    await serverReset();
    await withTab(`http://${B}/embed.html`, async () => { await sleep(1500); });
    assert(requested(await serverLog(), 'player.twitch.tv', '/'), 'module off');
  });

  // ---------------------------------------------------------------- profiles / script control
  const scripts = async (): Promise<{ title: string; log: Array<{ host: string; url: string }> }> => {
    await serverReset();
    const title = await withTab(`http://${A}/scripts.html`, async (tab) => { await sleep(800); return titleOf(tab.id!); });
    return { title, log: await serverLog() };
  };
  await reset();
  await check('balanced: all scripts run', async () => {
    const { title } = await scripts();
    for (const w of ['inline', 'first', 'third']) assert(words(title).includes(w), `${w} missing in "${title}"`);
  });
  await check('strict: third-party script is blocked before the network, first-party and inline still run', async () => {
    await send({ type: 'SET_PROFILE', profile: 'strict' });
    const { title, log } = await scripts();
    eq(words(title).sort(), ['first', 'inline', 's'], 'executed scripts');
    assert(!requested(log, T, '/third.js'), 'blocked script must not reach the server');
  });
  await check('strict + site exception (scripts): third-party script runs on that site', async () => {
    await send({ type: 'ADD_USER_RULE', rule: { module: 'scripts', effect: 'allow', duration: 'permanent', scope: { kind: 'site', site: A } } });
    const { title } = await scripts();
    assert(words(title).includes('third'), 'exception ignored: ' + title);
  });
  await check('exception for another site does not unlock this one', async () => {
    await reset();
    await send({ type: 'SET_PROFILE', profile: 'strict' });
    await send({ type: 'ADD_USER_RULE', rule: { module: 'scripts', effect: 'allow', duration: 'permanent', scope: { kind: 'site', site: B } } });
    const { title } = await scripts();
    assert(!words(title).includes('third'), 'must stay blocked: ' + title);
  });
  await check('lockdown: no JavaScript at all (inline, external, third-party)', async () => {
    await reset();
    await send({ type: 'SET_PROFILE', profile: 'lockdown' });
    const { title, log } = await scripts();
    eq(title, 's', 'title (no script may run)');
    assert(!requested(log, T, '/third.js'), 'third-party blocked before network');
  });
  await check('lockdown + paired site exception (scripts + inline): everything runs again, other sites stay locked', async () => {
    await send({ type: 'ADD_USER_RULE', rule: { module: 'scripts', effect: 'allow', duration: 'permanent', scope: { kind: 'site', site: A } } });
    await send({ type: 'ADD_USER_RULE', rule: { module: 'inline', effect: 'allow', duration: 'permanent', scope: { kind: 'site', site: A } } });
    const { title } = await scripts();
    for (const w of ['inline', 'first', 'third']) assert(words(title).includes(w), `${w} missing in "${title}"`);
    await serverReset();
    const other = await withTab(`http://${B}/scripts.html`, async (tab) => { await sleep(800); return titleOf(tab.id!); });
    eq(other, 's', 'site B stays locked');
  });
  await check('custom: inline strict blocks inline scripts but lets same-profile external scripts run', async () => {
    await reset();
    await send({ type: 'SET_MODULE_LEVEL', module: 'inline', level: 'strict' });
    const { title } = await scripts();
    assert(!words(title).includes('inline') && words(title).includes('first') && words(title).includes('third'), 'got "' + title + '"');
  });
  await check('profile switch keeps user rules (never silently deletes exceptions)', async () => {
    await reset();
    await send({ type: 'ADD_USER_RULE', rule: { module: 'scripts', effect: 'allow', duration: 'permanent', scope: { kind: 'site', site: A } } });
    await send({ type: 'SET_PROFILE', profile: 'lockdown' });
    await send({ type: 'SET_PROFILE', profile: 'balanced' });
    const r = await send({ type: 'GET_SETTINGS' });
    eq(r.settings.rules.length, 1, 'rules after profile round trip');
  });

  // ---------------------------------------------------------------- filter lists: network + cosmetic
  await reset();
  const LIST = [
    '[Adblock Plus 2.0]', `||${T}/ad-tracker.js`, `||${T}/ok.js`, `@@||${T}/ok.js`, `||${T}/imp.js$important`, `@@||${T}/imp.js`,
    '##.ad-banner', `${A}##.site-ad`
  ].join('\n');
  const adPage = async (): Promise<{ title: string; hidden: Record<string, string>; log: Array<{ host: string; url: string }> }> => {
    await serverReset();
    return withTab(`http://${A}/adblock.html`, async (tab) => {
      await sleep(2000);
      const hidden = await run(tab.id!, () => Object.fromEntries(['.ad-banner', '.site-ad', '.keep'].map((s) => [s, getComputedStyle(document.querySelector(s)!).display])));
      return { title: await titleOf(tab.id!), hidden, log: await serverLog() };
    });
  };
  await check('filter list: network blocks happen before the network, exceptions and $important behave like ABP', async () => {
    await seedList(LIST);
    const { title, log } = await adPage();
    assert(!requested(log, T, '/ad-tracker.js'), 'ad-tracker must be blocked');
    assert(requested(log, T, '/ok.js') && words(title).includes('ok'), 'exception must win over the block');
    assert(!requested(log, T, '/imp.js'), '$important must win over the exception');
  });
  await check('cosmetic filters: generic (via class token) and site-specific selectors hide elements, other elements stay', async () => {
    const { hidden } = await adPage();
    eq(hidden, { '.ad-banner': 'none', '.site-ad': 'none', '.keep': 'block' }, 'computed display');
  });
  await check('cosmetic filters do not apply on other sites', async () => {
    const hidden = await withTab(`http://${B}/adblock.html`, async (tab) => {
      await sleep(2000);
      return run(tab.id!, () => Object.fromEntries(['.ad-banner', '.site-ad'].map((s) => [s, getComputedStyle(document.querySelector(s)!).display])));
    });
    eq(hidden, { '.ad-banner': 'none', '.site-ad': 'block' }, 'site-specific selector must not leak to site B');
  });
  await check('"pause adblock on this site": network rules and cosmetic filters are off for that site only', async () => {
    await send({ type: 'ADD_USER_RULE', rule: { module: 'adblock', effect: 'allow', duration: 'permanent', scope: { kind: 'site', site: A } } });
    const { hidden, log } = await adPage();
    assert(requested(log, T, '/ad-tracker.js') && requested(log, T, '/imp.js'), 'paused: ads load');
    eq(hidden, { '.ad-banner': 'block', '.site-ad': 'block', '.keep': 'block' }, 'paused: nothing hidden');
    await serverReset();
    await withTab(`http://${B}/adblock.html`, async () => { await sleep(1000); });
    assert(!requested(await serverLog(), T, '/ad-tracker.js'), 'other sites remain protected');
  });
  await check('pause does not disable the URL cleaner', async () => {
    await serverReset();
    await withTab(`http://${A}/clean?utm_source=x&id=1`, async () => undefined);
    eq((await serverLog()).filter((r) => r.url.startsWith('/clean')).map((r) => r.url), ['/clean?id=1'], 'cleaned although adblock is paused');
  });
  await check('disabling the list removes its rules again', async () => {
    await send({ type: 'SET_LIST_ENABLED', id: 'easylist', enabled: false });
    await send({ type: 'REMOVE_USER_RULE', id: (await send({ type: 'GET_SETTINGS' })).settings.rules[0]?.id });
    const { log } = await adPage();
    assert(requested(log, T, '/ad-tracker.js'), 'list off -> no blocking');
  });

  // ---------------------------------------------------------------- bundled list snapshots (static rulesets, fixture bundle)
  await reset();
  const bundledPage = async (host = A): Promise<{ hidden: Record<string, string>; log: Array<{ host: string; url: string }> }> => {
    await serverReset();
    return withTab(`http://${host}/bundled.html`, async (tab) => {
      await sleep(2000);
      const hidden = await run(tab.id!, () => Object.fromEntries(['.bundled-ad', '.bundled-site-ad', '.keep'].map((s) => [s, getComputedStyle(document.querySelector(s)!).display])));
      return { hidden, log: await serverLog() };
    });
  };
  await check('bundled: package ships a snapshot but nothing is active until the user opts in', async () => {
    const st = await send({ type: 'GET_STATIC_LISTS' });
    assert(st.success && st.available && st.lists.length === 1, 'index: ' + JSON.stringify(st));
    eq(await browser.declarativeNetRequest.getEnabledRulesets(), [], 'enabled rulesets');
    const { log, hidden } = await bundledPage();
    assert(requested(log, T, '/bundled-ad.js'), 'default: not blocked');
    eq(hidden['.bundled-ad'], 'block', 'default: not hidden');
  });
  await check('bundled: enabling blocks before the network, exception wins, cosmetic filters work (generic and per site)', async () => {
    const r = await send({ type: 'SET_STATIC_LIST', id: 'easylist', enabled: true });
    assert(r.success, JSON.stringify(r));
    eq(await browser.declarativeNetRequest.getEnabledRulesets(), ['bundled-easylist'], 'enabled rulesets');
    const { log, hidden } = await bundledPage();
    assert(!requested(log, T, '/bundled-ad.js'), 'bundled-ad must be blocked');
    assert(requested(log, T, '/bundled-ok.js'), 'exception must win');
    eq(hidden, { '.bundled-ad': 'none', '.bundled-site-ad': 'none', '.keep': 'block' }, 'computed display on site A');
    eq((await bundledPage(B)).hidden['.bundled-site-ad'], 'block', 'site-specific selector must not leak to B');
  });
  await check('bundled: survives an applyPolicy round (profile change) and "pause adblock" lifts it for that site only', async () => {
    await send({ type: 'SET_PROFILE', profile: 'strict' });
    await send({ type: 'SET_PROFILE', profile: 'balanced' });
    eq(await browser.declarativeNetRequest.getEnabledRulesets(), ['bundled-easylist'], 'still enabled');
    await send({ type: 'ADD_USER_RULE', rule: { module: 'adblock', effect: 'allow', duration: 'permanent', scope: { kind: 'site', site: A } } });
    const paused = await bundledPage();
    assert(requested(paused.log, T, '/bundled-ad.js'), 'paused: ad loads');
    eq(paused.hidden['.bundled-ad'], 'block', 'paused: not hidden');
    assert(!requested((await bundledPage(B)).log, T, '/bundled-ad.js'), 'other sites stay protected');
    await send({ type: 'REMOVE_USER_RULE', id: (await send({ type: 'GET_SETTINGS' })).settings.rules.find((x: any) => x.module === 'adblock')?.id });
  });
  await check('bundled: a downloaded list with the same id replaces the snapshot (exclusive), and vice versa', async () => {
    await seedList(LIST);
    eq(await browser.declarativeNetRequest.getEnabledRulesets(), [], 'snapshot turned off by the downloaded list');
    const st = await send({ type: 'GET_STATIC_LISTS' });
    eq(st.lists[0].wanted, false, 'wanted flag cleared');
    const r = await send({ type: 'SET_STATIC_LIST', id: 'easylist', enabled: true });
    assert(r.success, JSON.stringify(r));
    eq((await send({ type: 'GET_LISTS' })).lists.find((l: any) => l.id === 'easylist').state.enabled, false, 'downloaded list turned off by the snapshot');
    eq(await browser.declarativeNetRequest.getEnabledRulesets(), ['bundled-easylist'], 'snapshot active');
  });
  await check('bundled: unknown ids are refused; module "off" in a custom profile disables the snapshot and re-enabling restores it', async () => {
    assert(!(await send({ type: 'SET_STATIC_LIST', id: 'nope', enabled: true })).success, 'unknown id accepted');
    await send({ type: 'SET_MODULE_LEVEL', module: 'adblock', level: 'off' });
    eq(await browser.declarativeNetRequest.getEnabledRulesets(), [], 'module off -> snapshot off');
    await send({ type: 'SET_MODULE_LEVEL', module: 'adblock', level: 'balanced' });
    eq(await browser.declarativeNetRequest.getEnabledRulesets(), ['bundled-easylist'], 'module balanced -> snapshot back');
  });
  await check('bundled: reset removes the choice and the rules', async () => {
    await send({ type: 'RESET_SETTINGS' });
    eq(await browser.declarativeNetRequest.getEnabledRulesets(), [], 'enabled rulesets after reset');
    eq((await send({ type: 'GET_STATIC_LISTS' })).lists[0].wanted, false, 'wanted after reset');
  });

  // ---------------------------------------------------------------- Cookie Vault
  await reset();
  await send({ type: 'SET_STORAGE_GRACE', ms: 0 });
  await send({ type: 'SET_SITE_POLICY', site: A, policy: 'ephemeral' });
  await send({ type: 'SET_SITE_POLICY', site: B, policy: 'persistent' });
  const cookieCount = async (domain: string) => (await browser.cookies.getAll({ domain })).length;
  const stateOf = async (host: string) => withTab(`http://${host}/state.html`, async (tab) => {
    await waitUntil(tab.id!, () => document.documentElement.dataset.ready === '1');
    return JSON.parse(await run(tab.id!, () => document.documentElement.dataset.state!));
  });
  await check('cookie vault: ephemeral site keeps its data while a tab is open', async () => {
    const t1 = await openTab(`http://${A}/cookie.html`);
    const t2 = await openTab(`http://${A}/state.html`);
    const tb = await openTab(`http://${B}/cookie.html`);
    assert((await cookieCount(A)) >= 3, 'cookies were set');
    await browser.tabs.remove(t1.id!);
    await sleep(2500);
    assert((await cookieCount(A)) >= 3, 'second tab still open -> nothing may be deleted');
    await browser.tabs.remove(t2.id!);
    for (let i = 0; i < 30 && (await cookieCount(A)) > 0; i++) await sleep(500);
    eq(await cookieCount(A), 0, 'cookies of the closed ephemeral site');
    await browser.tabs.remove(tb.id!);
  });
  await check('cookie vault: persistent site keeps cookies; ephemeral site lost localStorage, persistent kept it', async () => {
    assert((await cookieCount(B)) >= 3, 'persistent site cookies must stay');
    eq((await stateOf(A)).ls, 0, 'localStorage of ephemeral site');
    eq((await stateOf(B)).ls, 1, 'localStorage of persistent site');
  });
  await check('cookie vault: cleanup result is reported and verified without cookie names/values', async () => {
    const st = await send({ type: 'GET_STORAGE_STATUS' });
    const r = st.status.results.find((x: { site: string; cookiesRemoved: number }) => x.site === A && x.cookiesRemoved >= 3);
    assert(r && r.ok && r.cookiesRemoved >= 3 && r.cookiesRemaining === 0, 'result: ' + JSON.stringify(r));
    assert(!JSON.stringify(st).includes('sid'), 'no cookie names in status');
  });
  await check('cookie vault: manual cleanup respects "persistent"', async () => {
    const t = await openTab(`http://${B}/cookie.html`);
    await browser.tabs.remove(t.id!);
    await sleep(800);
    await send({ type: 'CLEAN_SITE_NOW', site: B });
    assert((await cookieCount(B)) >= 3, 'persistent site must not be cleaned manually either');
  });


  // ---------------------------------------------------------------- Cookie-banner manager (fixtures, not vendor scripts)
  const cmp = async (path: string, host = A, waitMs = 7000, expectOutcome = true, settleMs = 0): Promise<{ consent?: string; other?: string; clicked?: string; display: string | null }> =>
    withTab(`http://${host}${path}`, async (tab) => {
      const end = Date.now() + waitMs;
      while (Date.now() < end) {
        const done = await run(tab.id!, () => document.documentElement.dataset.consent !== undefined).catch(() => false);
        if (expectOutcome && done) break;
        await sleep(250);
      }
      if (settleMs) await sleep(settleMs); // the content script reports AFTER the dialog is gone; closing the tab earlier would drop the report
      return run(tab.id!, () => {
        const root = document.querySelector('[data-cmp-root], #usercentrics-root') as HTMLElement | null;
        const target = (root && (root.querySelector('#onetrust-banner-sdk, #didomi-popup, .cookie-notice, .qc-cmp2-summary-buttons') as HTMLElement | null)) || root;
        return { ...(document.documentElement.dataset as Record<string, string>), display: target ? getComputedStyle(target).display : null };
      });
    });
  const fx = (name: string) => `/cmp/page.html?f=${name}`;
  // Note: earlier sections toggle resistFingerprinting and Firefox may leave the headless window at 300x150, so the
  // fixtures use a slim bar (40px) that stays below the "wall" threshold (50% of the viewport) even in that window.
  await reset();
  const rejected: Array<[string, string, string]> = [
    ['OneTrust (reject button on the first layer)', fx('onetrust'), 'rejected'],
    ['OneTrust (refusal only inside the preference center)', fx('onetrust-pc'), 'rejected'],
    ['Cookiebot (decline button)', fx('cookiebot'), 'rejected'],
    ['Cookiebot (only "allow selection": optional purposes get unchecked first)', fx('cookiebot-selection'), 'selection:necessary'],
    ['Usercentrics (inside an open shadow root)', '/cmp/usercentrics.html', 'rejected'],
    ['Klaro', fx('klaro'), 'rejected'],
    ['Didomi (IAB TCF)', fx('didomi'), 'rejected'],
    ['Quantcast Choice (IAB TCF)', fx('quantcast'), 'rejected'],
    ['unknown German dialog (generic detector, "Nur notwendige")', fx('generic-de'), 'rejected'],
    ['full-screen wall dialog is still refused through its own reject button', fx('wall'), 'rejected']
  ];
  for (const [name, path, expected] of rejected) {
    await check(`consent reject: ${name}`, async () => { eq((await cmp(path)).consent, expected, 'outcome'); });
  }
  await check('consent reject: dialogs that only offer accept/customize are left completely alone', async () => {
    const r = await cmp(fx('trap'), A, 4000, false);
    eq([r.consent, r.other, r.display === 'none'], [undefined, undefined, false], 'trap dialog must stay untouched');
  });
  await check('consent reject: a vendor id on a control labelled "Accept all" is NEVER clicked', async () => {
    const r = await cmp(fx('trap-spoof'), A, 4000, false);
    eq([r.consent, r.display === 'none'], [undefined, false], 'spoofed reject id');
  });
  await check('consent reject: buttons outside a consent dialog are never clicked', async () => {
    const r = await cmp('/cmp/nonbanner.html', A, 3500, false);
    eq(r.clicked, undefined, 'article buttons');
  });
  await check('consent: nothing in the whole suite ever resulted in accepted consent', async () => {
    for (const [, path] of rejected) { const r = await cmp(path, A, 1500, true); assert(r.consent !== 'accepted', `${path} accepted`); }
  });

  await check('consent hide: a non-blocking bar is hidden without any click or consent', async () => {
    await send({ type: 'SET_CONSENT_MODE', mode: 'hide' });
    const r = await cmp(fx('onetrust'), A, 5000, false);
    const st = await send({ type: 'GET_CONSENT_STATUS' });
    eq([r.display, r.consent], ['none', undefined], 'bar hidden, no decision recorded; stats ' + JSON.stringify(st.stats) + ' mode ' + st.mode);
  });
  await check('consent hide: a blocking wall is NOT hidden (would hide a required interaction)', async () => {
    const r = await cmp(fx('wall'), A, 4500, false);
    assert(r.display !== 'none' && r.consent === undefined, `wall: ${JSON.stringify(r)}`);
  });
  await check('consent hide: dialogs without a clear refuse/accept pair stay visible', async () => {
    const r = await cmp(fx('trap'), A, 4000, false);
    assert(r.display !== 'none', 'trap must not be hidden');
  });
  await check('consent manual: AnoFox does not touch banners', async () => {
    await send({ type: 'SET_CONSENT_MODE', mode: 'manual' });
    const r = await cmp(fx('onetrust'), A, 4000, false);
    eq([r.consent, r.display === 'none'], [undefined, false], 'manual');
  });
  await check('consent: module switched off beats an explicit reject mode', async () => {
    await send({ type: 'SET_CONSENT_MODE', mode: 'reject' });
    await send({ type: 'SET_MODULE_LEVEL', module: 'consent', level: 'off' });
    const r = await cmp(fx('onetrust'), A, 4000, false);
    eq(r.consent, undefined, 'off');
  });
  await check('consent: a per-site rule pauses the automation for that site only', async () => {
    await reset();
    await send({ type: 'ADD_USER_RULE', rule: { module: 'consent', effect: 'allow', duration: 'permanent', scope: { kind: 'site', site: A } } });
    const paused = await cmp(fx('onetrust'), A, 4000, false);
    eq(paused.consent, undefined, 'paused site');
    eq((await cmp(fx('onetrust'), B)).consent, 'rejected', 'other site');
  });
  await check('consent: status reports honest counters and rejects unknown modes', async () => {
    await reset();
    await cmp(fx('klaro'), A, 7000, true, 1500);
    const st = await send({ type: 'GET_CONSENT_STATUS' });
    assert(st.success && st.mode === 'reject' && st.stats.klaro?.rejected >= 1, 'stats ' + JSON.stringify(st.stats));
    assert(st.adapters.some((a: { id: string }) => a.id === 'usercentrics'), 'adapter list');
    eq((await send({ type: 'SET_CONSENT_MODE', mode: 'accept-all' })).success, false, 'unknown mode');
    eq((await send({ type: 'GET_CONSENT_STATUS' })).setting, 'auto', 'unchanged');
  });


  // ---------------------------------------------------------------- phishing / malware protection (local lists only)
  const M = 'anofox-m.test';
  const M2 = 'anofox-m2.test';
  const P = 'login.anofox-p.test';
  const applyThreat = async (): Promise<void> => {
    assert((await send({ type: 'E2E_APPLY_THREAT_DOMAINS', listId: 'urlhaus-online', domains: [M, M2] })).success, 'e2e hook (malware)');
    assert((await send({ type: 'E2E_APPLY_THREAT_DOMAINS', listId: 'phishing-filter', domains: [P] })).success, 'e2e hook (phishing)');
  };
  const isWarning = (url: string | undefined) => !!url && /^moz-extension:\/\/[^/]+\/blocked\.html\?l=/.test(url);
  const nav = async (url: string): Promise<{ tab: browser.tabs.Tab; finalUrl: string }> => {
    const tab = await openTab(url);
    const t = await browser.tabs.get(tab.id!);
    return { tab: t, finalUrl: t.url ?? '' };
  };
  const warningView = (): any => (browser as any).extension.getViews({ type: 'tab' }).find((v: Window) => v.location.href.includes('/blocked.html'));
  await reset();
  await applyThreat();
  await check('threat: lists are off by default and the status API lists all sources with license and attribution', async () => {
    const st = await send({ type: 'GET_THREAT_STATUS' });
    assert(st.success && st.lists.length >= 3, 'lists');
    assert(st.lists.every((l: any) => l.state.enabled === false && l.license && l.attribution), 'all disabled with license text');
  });
  await check('threat: a listed malware host is replaced by the warning page BEFORE the network', async () => {
    await serverReset();
    const { tab, finalUrl } = await nav(`http://${M}/payload?x=1&y=2#f`);
    assert(isWarning(finalUrl), 'not redirected: ' + finalUrl);
    assert(finalUrl.includes(`l=urlhaus-online&u=http://${M}/payload?x=1&y=2#f`), 'warning must carry list id and the original URL: ' + finalUrl);
    assert(!(await serverLog()).some((r) => r.host === M), 'request must never reach the server');
    await browser.tabs.remove(tab.id!);
  });
  await check('threat: subdomains of a listed host and the phishing list are blocked too; unlisted hosts load', async () => {
    await serverReset();
    for (const [url, list] of [[`http://sub.deep.${M}/x`, 'urlhaus-online'], [`http://${P}/signin`, 'phishing-filter']] as const) {
      const { tab, finalUrl } = await nav(url);
      assert(isWarning(finalUrl) && finalUrl.includes(`l=${list}`), `${url} -> ${finalUrl}`);
      await browser.tabs.remove(tab.id!);
    }
    const ok = await nav(`http://${B}/clean`);
    assert(!isWarning(ok.finalUrl), 'unlisted host must load');
    await browser.tabs.remove(ok.tab.id!);
    const log = await serverLog();
    assert(!log.some((r) => r.host.endsWith(M) || r.host === P) && log.some((r) => r.host === B), 'server log ' + JSON.stringify(log));
  });
  await check('threat: subresources (script, image) from a listed host are blocked inside an ordinary page', async () => {
    await serverReset();
    const title = await withTab(`http://${A}/threat-sub.html`, async (tab) => { await sleep(1200); return titleOf(tab.id!); });
    eq(title, 'page', 'page itself loads');
    assert(!(await serverLog()).some((r) => r.host === M), 'no request to the listed host');
  });
  await check('threat: warning page "open anyway" lifts the block for that host only and for the chosen time', async () => {
    await serverReset();
    const { tab } = await nav(`http://${M}/payload`);
    assert(isWarning(tab.url), 'warning shown');
    const view = warningView();
    assert(view, 'warning view');
    eq(view.document.getElementById('host').textContent, M, 'host shown');
    (view.document.getElementById('duration') as HTMLSelectElement).value = '10';
    (view.document.getElementById('proceed') as HTMLButtonElement).click();
    let reached = false;
    for (let i = 0; i < 30 && !reached; i++) { await sleep(300); reached = (await serverLog()).some((r) => r.host === M && r.url === '/payload'); }
    assert(reached, 'after "open anyway" the request must reach the server');
    await browser.tabs.remove(tab.id!);
    const other = await nav(`http://${M2}/x`);
    assert(isWarning(other.finalUrl), 'other listed host stays blocked');
    await browser.tabs.remove(other.tab.id!);
    const again = await nav(`http://${M}/again`);
    assert(!isWarning(again.finalUrl), 'bypass persists for the host');
    await browser.tabs.remove(again.tab.id!);
  });
  await check('threat: only the real warning page may grant a bypass (messages from anywhere else are refused)', async () => {
    eq((await send({ type: 'THREAT_BYPASS', duration: 'session' })).success, false, 'driver page is not the warning page');
  });
  await check('threat: adblock pause and the URL cleaner never lift a threat block', async () => {
    await reset();
    await applyThreat();
    await send({ type: 'ADD_USER_RULE', rule: { module: 'adblock', effect: 'allow', duration: 'permanent', scope: { kind: 'site', site: A } } });
    await serverReset();
    await withTab(`http://${A}/threat-sub.html`, async () => { await sleep(1200); });
    assert(!(await serverLog()).some((r) => r.host === M), 'paused adblock must not unblock malware');
    const { tab, finalUrl } = await nav(`http://${M}/x?utm_source=a`);
    assert(isWarning(finalUrl), 'cleaner redirect must not bypass the warning: ' + finalUrl);
    await browser.tabs.remove(tab.id!);
  });
  await check('threat: deceptive user-info URL ("trusted-name@other-server") is stopped before the network and can be opened on purpose', async () => {
    await reset();
    await serverReset();
    const { tab, finalUrl } = await nav(`http://paypal.com@${B}/clean?z=1`);
    assert(isWarning(finalUrl) && finalUrl.includes('l=userinfo'), 'not warned: ' + finalUrl);
    assert(!(await serverLog()).some((r) => r.host === B), 'no request before the user decides');
    const view = warningView();
    (view.document.getElementById('proceed') as HTMLButtonElement).click();
    let reached = false;
    for (let i = 0; i < 30 && !reached; i++) { await sleep(300); reached = (await serverLog()).some((r) => r.host === B); }
    const t2 = await browser.tabs.get(tab.id!);
    const rules = await browser.declarativeNetRequest.getSessionRules();
    assert(reached, 'user can still open it deliberately; tab=' + t2.url + ' sessionRules=' + JSON.stringify(rules.map((r) => [r.id, r.condition.requestDomains])) + ' log=' + JSON.stringify(await serverLog()));
    await browser.tabs.remove(tab.id!);
  });
  await check('threat: module "Phishing" off switches the deceptive-URL warning off', async () => {
    await reset();
    await send({ type: 'SET_MODULE_LEVEL', module: 'phishing', level: 'off' });
    await serverReset();
    const { tab, finalUrl } = await nav(`http://paypal.com@${B}/clean?z=2`);
    assert(!isWarning(finalUrl), 'must not warn when the module is off: ' + finalUrl);
    await browser.tabs.remove(tab.id!);
  });
  await check('threat: reset removes list rules and revokes bypasses', async () => {
    await reset();
    await applyThreat();
    await reset();
    await serverReset();
    const { tab, finalUrl } = await nav(`http://${M}/after-reset`);
    assert(!isWarning(finalUrl), 'rules must be gone after reset: ' + finalUrl);
    await browser.tabs.remove(tab.id!);
  });


  // ---------------------------------------------------------------- UI: landmarks, names, keyboard, responsive, contrast (real rendering)
  const frame = async (path: string, width: number): Promise<{ doc: Document; win: Window; el: HTMLIFrameElement }> => {
    const f = document.createElement('iframe');
    f.src = browser.runtime.getURL(path);
    f.style.cssText = `width:${width}px;height:900px;border:0;display:block`;
    document.body.appendChild(f);
    await new Promise<void>((r) => { f.addEventListener('load', () => r(), { once: true }); setTimeout(r, 6000); });
    await sleep(900);
    return { doc: f.contentDocument!, win: f.contentWindow!, el: f };
  };
  const visible = (e: Element) => e.getClientRects().length > 0 && !e.closest('[hidden]');
  const nameOf = (doc: Document, e: Element): string => {
    const aria = e.getAttribute('aria-label'); if (aria) return aria.trim();
    const lb = e.getAttribute('aria-labelledby');
    if (lb) return lb.split(' ').map((id) => doc.getElementById(id)?.textContent ?? '').join(' ').trim();
    if (e.id) { const l = doc.querySelector(`label[for="${e.id}"]`); if (l) return (l.textContent ?? '').trim(); }
    const wrap = e.closest('label'); if (wrap) return (wrap.textContent ?? '').trim();
    if (e instanceof HTMLInputElement && ['button', 'submit'].includes(e.type)) return e.value;
    return ((e.textContent ?? '').trim() || e.getAttribute('title') || '').trim();
  };
  const INTERACTIVE = 'button, a[href], select, input:not([type="hidden"]), textarea, [role="button"], [role="switch"], summary';
  const rgb = (c: string): [number, number, number, number] => { const m = c.match(/rgba?\(([^)]+)\)/)!; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]; };
  const lum = ([r, g, b]: number[]) => { const f = (v: number) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const ratio = (a: number[], b: number[]) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
  const bgOf = (win: Window, e: Element): [number, number, number] => {
    const layers: number[][] = [];
    for (let n: Element | null = e; n; n = n.parentElement) { const c = rgb(win.getComputedStyle(n).backgroundColor); if (c[3] > 0) layers.push(c); if (c[3] >= 0.999) break; }
    let base: number[] = [0, 0, 0];
    for (const l of layers.reverse()) base = [0, 1, 2].map((i) => l[i] * l[3] + base[i] * (1 - l[3]));
    return base as [number, number, number];
  };
  const lowContrast = (win: Window, doc: Document): string[] => {
    const bad: string[] = [];
    for (const e of Array.from(doc.body.querySelectorAll('*'))) {
      if (!visible(e) || !Array.from(e.childNodes).some((n) => n.nodeType === 3 && (n.textContent ?? '').trim())) continue;
      if (e instanceof HTMLElement && (e.closest('select') || e.tagName === 'OPTION')) continue;
      const cs = win.getComputedStyle(e);
      if (cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;
      const fg = rgb(cs.color); const bg = bgOf(win, e);
      const fgBlend = [0, 1, 2].map((i) => fg[i] * fg[3] + bg[i] * (1 - fg[3]));
      const px = parseFloat(cs.fontSize); const large = px >= 24 || (px >= 18.66 && Number(cs.fontWeight) >= 700);
      const r = ratio(fgBlend, bg);
      if (r < (large ? 3 : 4.5)) bad.push(`${e.tagName.toLowerCase()}.${(e.className || '').toString().split(' ')[0]} "${(e.textContent ?? '').trim().slice(0, 30)}" ${r.toFixed(2)}`);
    }
    return bad;
  };
  const TABS = ['tab-overview', 'tab-policy', 'tab-rules', 'tab-cleaner', 'tab-embeds', 'tab-lists', 'tab-threat', 'tab-consent', 'tab-storage', 'tab-fingerprint', 'tab-stats', 'tab-terminal', 'tab-backup'];
  await reset();
  await check('ui options: one banner/nav/main landmark, skip link first and working, page language set, single h1', async () => {
    const { doc, el } = await frame('options.html', 1200);
    eq([doc.documentElement.lang, doc.querySelectorAll('main').length, doc.querySelectorAll('nav[aria-label]').length, doc.querySelectorAll('h1').length], ['de', 1, 1, 1], 'landmarks');
    const first = doc.querySelector(INTERACTIVE) as HTMLAnchorElement;
    assert(first.classList.contains('skip-link') && first.getAttribute('href') === '#main', 'skip link must be the first focusable element');
    assert(doc.getElementById('main')!.tabIndex === -1, 'main must be programmatically focusable');
    el.remove();
  });
  await check('ui options: navigation sets aria-current, shows exactly one pane, updates title and hash; panes are labelled regions', async () => {
    const { doc, el } = await frame('options.html', 1200);
    for (const id of TABS) {
      (doc.querySelector(`.nav-link[data-tab="${id}"]`) as HTMLElement).click();
      await sleep(150);
      const current = Array.from(doc.querySelectorAll('.nav-link[aria-current="page"]')).map((b) => (b as HTMLElement).dataset.tab);
      eq(current, [id], 'aria-current');
      eq(Array.from(doc.querySelectorAll('.tab-pane')).filter((p) => !(p as HTMLElement).hidden).map((p) => p.id), [id], 'visible panes');
      const pane = doc.getElementById(id)!;
      assert(pane.getAttribute('role') === 'region' && !!pane.getAttribute('aria-label'), `${id} needs role=region and a name`);
      assert(doc.title.startsWith('AnoFox – ') && doc.location.hash === `#${id}`, `title/hash for ${id}: ${doc.title} ${doc.location.hash}`);
    }
    el.remove();
  });
  await check('ui options: every visible control in every pane has an accessible name', async () => {
    const { doc, el } = await frame('options.html', 1200);
    const missing: string[] = [];
    for (const id of TABS) {
      (doc.querySelector(`.nav-link[data-tab="${id}"]`) as HTMLElement).click();
      await sleep(900);
      for (const c of Array.from(doc.querySelectorAll(INTERACTIVE))) if (visible(c) && !nameOf(doc, c)) missing.push(`${id}: <${c.tagName.toLowerCase()} ${(c as HTMLElement).id || c.className}>`);
    }
    eq(missing, [], 'controls without a name');
    el.remove();
  });
  await check('ui options: heading levels never skip (h1 > h2 > h3) inside each pane', async () => {
    const { doc, el } = await frame('options.html', 1200);
    const problems: string[] = [];
    for (const id of TABS) {
      (doc.querySelector(`.nav-link[data-tab="${id}"]`) as HTMLElement).click();
      await sleep(700);
      let prev = 2;
      for (const hd of Array.from(doc.getElementById(id)!.querySelectorAll('h1,h2,h3,h4')).filter(visible)) {
        const lvl = Number(hd.tagName[1]);
        if (lvl > prev + 1) problems.push(`${id}: h${prev} -> h${lvl} "${(hd.textContent ?? '').slice(0, 30)}"`);
        prev = lvl;
      }
    }
    eq(problems, [], 'skipped heading levels');
    el.remove();
  });
  for (const theme of ['dark', 'light'] as const) {
    await check(`ui options: text contrast meets WCAG AA in the real rendering (${theme} theme, all panes)`, async () => {
      const { doc, win, el } = await frame('options.html', 1200);
      doc.documentElement.setAttribute('data-theme', theme);
      const bad: string[] = [];
      for (const id of TABS) {
        (doc.querySelector(`.nav-link[data-tab="${id}"]`) as HTMLElement).click();
        await sleep(800);
        bad.push(...lowContrast(win, doc).map((b) => `${id}: ${b}`));
      }
      eq(bad.slice(0, 12), [], `${bad.length} low-contrast text elements`);
      el.remove();
    });
  }
  await check('ui options: no horizontal scrolling at phone width (360px) and the sidebar collapses', async () => {
    const { doc, win, el } = await frame('options.html', 360);
    const over: string[] = [];
    for (const id of ['tab-overview', 'tab-policy', 'tab-rules', 'tab-storage', 'tab-threat', 'tab-consent']) {
      (doc.querySelector(`.nav-link[data-tab="${id}"]`) as HTMLElement).click();
      await sleep(800);
      if (doc.documentElement.scrollWidth > 361) {
        const wide = Array.from(doc.getElementById(id)!.querySelectorAll('*')).filter((n) => n.getBoundingClientRect().right > 362)
          .slice(0, 4).map((n) => `${n.tagName.toLowerCase()}.${(n.className || '').toString().split(' ')[0]}(${Math.round(n.getBoundingClientRect().right)})`);
        over.push(`${id}: ${doc.documentElement.scrollWidth}px by ${wide.join(', ')}`);
      }
    }
    eq(over, [], 'horizontal overflow');
    assert(win.getComputedStyle(doc.querySelector('.layout')!).gridTemplateColumns.split(' ').length === 1, 'single column layout');
    el.remove();
  });
  await check('ui popup: controls are named, switches are real focusable checkboxes with role=switch, status is a live region', async () => {
    const { doc, win, el } = await frame('popup.html', 360);
    const missing = Array.from(doc.querySelectorAll(INTERACTIVE)).filter((c) => !nameOf(doc, c)).map((c) => (c as HTMLElement).id || c.tagName);
    eq(missing, [], 'popup controls without a name');
    const sw = Array.from(doc.querySelectorAll('input[role="switch"]')) as HTMLInputElement[];
    assert(sw.length === 4 && sw.every((i) => i.type === 'checkbox' && i.tabIndex >= 0), 'four reachable switches');
    assert(doc.getElementById('status')!.getAttribute('aria-live') === 'polite', 'live region');
    assert(doc.querySelector('main') && doc.querySelector('h1'), 'landmarks');
    assert(doc.documentElement.scrollWidth <= 361, 'no horizontal overflow');
    for (const theme of ['dark', 'light']) {
      doc.documentElement.setAttribute('data-theme', theme);
      await sleep(200);
      eq(lowContrast(win, doc).slice(0, 8), [], `popup contrast ${theme}`);
    }
    el.remove();
  });
  await check('ui warning page: landmarks, named buttons, correct heading, and an invalid call disables "open anyway"', async () => {
    const ok = await frame('blocked.html?l=phishing-filter&u=http://login.example.test/x', 480);
    eq([ok.doc.querySelectorAll('main').length, ok.doc.querySelectorAll('h1').length, ok.doc.documentElement.lang], [1, 1, 'de'], 'landmarks');
    assert(ok.doc.getElementById('title')!.textContent === 'Verdacht auf Phishing' && ok.doc.getElementById('host')!.textContent === 'login.example.test', 'content');
    eq(Array.from(ok.doc.querySelectorAll(INTERACTIVE)).filter((c) => !nameOf(ok.doc, c)).length, 0, 'named controls');
    eq(lowContrast(ok.win, ok.doc).slice(0, 6), [], 'warning page contrast');
    ok.el.remove();
    const bad = await frame('blocked.html?l=x&u=javascript:alert(1)', 480);
    assert((bad.doc.getElementById('proceed') as HTMLButtonElement).disabled, 'invalid call must not allow bypass');
    bad.el.remove();
  });

  await check('ui overview: one card per module with truthful status, honest hints, and "Konfigurieren" opens the right pane', async () => {
    await reset();
    await send({ type: 'SET_PROFILE', profile: 'strict' });
    const { doc, el } = await frame('options.html#tab-overview', 1200);
    await sleep(500);
    const cards = Array.from(doc.querySelectorAll('#mount-overview .ui-grid')[0].querySelectorAll('.ui-card'));
    eq(cards.length, 12, 'one card per module');
    const text = (n: Element) => n.textContent ?? '';
    const find = (label: string) => cards.find((c) => text(c.querySelector('h3')!) === label)!;
    assert(text(find('Fingerprinting-Schutz')).includes('Strict') && text(find('Cookie-Banner')).includes('experimentell'), 'levels and experimental flags');
    assert(text(doc.getElementById('mount-overview')!).includes('Aktives Profil: Strict'), 'profile');
    assert(text(doc.getElementById('mount-overview')!).includes('Phishing- und Malware-Listen sind nicht aktiviert'), 'honest hint: no list enabled');
    (Array.from(find('Phishing').querySelectorAll('button')).find((b) => b.textContent === 'Konfigurieren') as HTMLElement).click();
    await sleep(400);
    eq((doc.querySelector('.nav-link[aria-current="page"]') as HTMLElement).dataset.tab, 'tab-threat', 'navigated to the threat pane');
    el.remove();
  });
  await check('ui options: picking a profile (toggles resistFingerprinting) keeps the page responsive and keyboard focus on the same button', async () => {
    // Run in a real tab: toggling resistFingerprinting while the page sits in an iframe of this driver page freezes headless Firefox
    // (a test-environment quirk, not reproducible with the page in its own tab).
    await reset();
    const tab = await openTab(browser.runtime.getURL('options.html#tab-policy'));
    await sleep(1000);
    const view = (browser as any).extension.getViews({ type: 'tab' }).find((v: Window) => v.location.href.includes('options.html'));
    assert(view, 'options view');
    const strict = Array.from(view.document.querySelectorAll('#mount-profiles .policy-profile')).find((b: any) => (b.textContent ?? '').startsWith('Strict')) as HTMLButtonElement;
    strict.focus();
    strict.click();
    await sleep(2500);
    const active = view.document.activeElement as HTMLElement;
    assert((active.textContent ?? '').startsWith('Strict') && active.getAttribute('aria-pressed') === 'true',
      'focus lost after re-render: ' + active.tagName + ' ' + (active.textContent ?? '').slice(0, 20));
    await browser.tabs.remove(tab.id!);
    await send({ type: 'SET_PROFILE', profile: 'balanced' });
  });
  await check('ui options: a select keeps keyboard focus after its change re-renders the section (consent mode)', async () => {
    await reset();
    const { doc, el } = await frame('options.html#tab-consent', 1200);
    await sleep(600);
    const sel = doc.querySelector('select[aria-label="Modus des Consent-Managers"]') as HTMLSelectElement;
    sel.focus();
    sel.value = 'manual';
    sel.dispatchEvent(new Event('change'));
    await sleep(1500);
    const now = doc.activeElement as HTMLSelectElement;
    assert(now.tagName === 'SELECT' && now.getAttribute('aria-label') === 'Modus des Consent-Managers' && now.value === 'manual', 'focus/value after re-render: ' + now.tagName + ' ' + now.value);
    el.remove();
  });
  await check('ui stylesheet: visible focus ring (>=3px), reduced-motion and forced-colors support, minimum target size', async () => {
    const css = await (await fetch(browser.runtime.getURL('ui.css'))).text();
    assert(/:focus-visible\s*\{[^}]*outline:\s*3px/.test(css), 'focus ring');
    assert(css.includes('prefers-reduced-motion: reduce') && css.includes('forced-colors: active'), 'media preferences');
    assert(/min-height:\s*36px/.test(css), 'target size');
  });


  // ---------------------------------------------------------------- real downloads (npm run test:e2e:download, needs internet)
  if (networkMode) {
    const dyn = async () => browser.declarativeNetRequest.getDynamicRules();
    const inRange = (rules: Array<{ id: number }>, lo: number, hi: number) => rules.filter((r) => r.id >= lo && r.id <= hi).length;
    const listedHost = async (url: string): Promise<string> => {
      const text = await (await fetch(url)).text();
      const line = text.split('\n').find((l) => l.trim() && !l.startsWith('#') && /^[a-z0-9.-]+$/i.test(l.trim()) && l.includes('.'));
      assert(line, 'no usable entry in ' + url);
      return line!.trim().toLowerCase();
    };
    await reset();
    await check('download: urlhaus-online is fetched over HTTPS, validated, compiled and installed; a listed host is stopped before the network', async () => {
      const r = await send({ type: 'SET_THREAT_LIST_ENABLED', id: 'urlhaus-online', enabled: true });
      assert(r.success, 'enable failed: ' + JSON.stringify(r));
      const st = (await send({ type: 'GET_THREAT_STATUS' })).lists.find((l: any) => l.id === 'urlhaus-online').state;
      assert(st.installed && st.current.filterCount > 100 && st.ruleCount >= 2 && st.current.sha256.length === 64, 'state ' + JSON.stringify(st));
      const host = await listedHost('https://malware-filter.gitlab.io/malware-filter/urlhaus-filter-domains-online.txt');
      const tab = await openTab(`http://${host}/`);
      const url = (await browser.tabs.get(tab.id!)).url ?? '';
      await browser.tabs.remove(tab.id!);
      assert(/^moz-extension:\/\/[^/]+\/blocked\.html\?l=urlhaus-online&u=/.test(url), `${host} -> ${url}`);
    });
    await check('download: phishing-filter (~30 000 entries) installs and a listed phishing host shows the warning', async () => {
      const r = await send({ type: 'SET_THREAT_LIST_ENABLED', id: 'phishing-filter', enabled: true });
      assert(r.success, 'enable failed: ' + JSON.stringify(r));
      const st = (await send({ type: 'GET_THREAT_STATUS' })).lists.find((l: any) => l.id === 'phishing-filter').state;
      assert(st.installed && st.current.filterCount > 5000, 'state ' + JSON.stringify(st));
      const host = await listedHost('https://malware-filter.gitlab.io/malware-filter/phishing-filter-domains.txt');
      const tab = await openTab(`http://${host}/login`);
      const url = (await browser.tabs.get(tab.id!)).url ?? '';
      await browser.tabs.remove(tab.id!);
      assert(url.includes('blocked.html?l=phishing-filter'), `${host} -> ${url}`);
    });
    await check('download: EasyList + EasyPrivacy respect the real Firefox quota and are reported as partial instead of failing', async () => {
      const a = await send({ type: 'SET_LIST_ENABLED', id: 'easylist', enabled: true });
      assert(a.success && a.summary.applied, 'easylist: ' + JSON.stringify(a.summary));
      const b = await send({ type: 'SET_LIST_ENABLED', id: 'easyprivacy', enabled: true }).catch(() => null);
      const rules = await dyn();
      const adRules = inRange(rules, 100_000, 199_999);
      assert(adRules > 1000, 'expected thousands of list rules, got ' + adRules);
      assert(rules.length <= 5000, 'dynamic rule quota exceeded: ' + rules.length);
      assert(inRange(rules, 200_000, 299_999) > 0, 'threat rules must survive next to the adblock lists (budget reserve)');
      const lists = (await send({ type: 'GET_LISTS' })).lists;
      assert(lists.find((l: any) => l.id === 'easylist').state.current.filterCount > 20000, 'easylist parsed');
      return `adblock rules ${adRules}, threat rules ${inRange(rules, 200_000, 299_999)}, dynamic total ${rules.length}/5000; EasyPrivacy stats ${JSON.stringify(b && b.summary && b.summary.stats)}`;
    });
    await check('download: lists keep ETag/sha256 for conditional updates, and reset removes every list rule', async () => {
      const lists = (await send({ type: 'GET_LISTS' })).lists;
      const cur = lists.find((l: any) => l.id === 'easylist').state.current;
      assert(cur.sha256.length === 64 && cur.etag, 'conditional-request metadata missing: ' + JSON.stringify(cur));
      await reset();
      const rules = await dyn();
      eq(inRange(rules, 100_000, 299_999) - rules.filter((r) => r.id === 299_990).length, 0, 'list rules after reset (the local userinfo-warning rule 299990 is not a list rule and stays)');
    });
  }

  // ---------------------------------------------------------------- native Firefox settings
  await reset();
  await check('native: strict profile enables resistFingerprinting browser-wide and takes control; balanced releases it', async () => {
    await send({ type: 'SET_PROFILE', profile: 'strict' });
    const on = await browser.privacy.websites.resistFingerprinting.get({});
    eq([on.value, on.levelOfControl], [true, 'controlled_by_this_extension'], 'strict');
    await send({ type: 'SET_PROFILE', profile: 'balanced' });
    const off = await browser.privacy.websites.resistFingerprinting.get({});
    eq([off.value, off.levelOfControl], [false, 'controllable_by_this_extension'], 'balanced (control released with clear())');
  });
  await check('native: per-setting override "never touch" wins over the profile', async () => {
    await send({ type: 'SET_PROFILE', profile: 'strict' });
    await send({ type: 'SET_NATIVE_OVERRIDE', id: 'resistFingerprinting', override: 'off' });
    const g = await browser.privacy.websites.resistFingerprinting.get({});
    eq([g.value, g.levelOfControl], [false, 'controllable_by_this_extension'], 'override off');
  });
  await check('native: the status API reports honestly (httpsOnlyMode is not offered, referrer/webrtc known)', async () => {
    const st = await send({ type: 'GET_NATIVE_STATUS' });
    assert(st.success && st.status.length >= 5, 'status list');
    assert(!st.status.some((s: { id: string }) => s.id === 'httpsOnlyMode'), 'httpsOnlyMode is not controllable and must not be listed');
  });

  // ---------------------------------------------------------------- settings robustness
  await reset();
  await check('settings: invalid import is rejected and existing settings stay', async () => {
    await send({ type: 'SET_PROFILE', profile: 'strict' });
    const bad = await send({ type: 'IMPORT_SETTINGS', text: '{ not json' });
    eq(bad.success, false, 'import of garbage');
    eq((await send({ type: 'GET_SETTINGS' })).settings.profile, 'strict', 'profile unchanged');
  });
  await check('settings: import validates every field (unknown module/profile/rules cannot sneak in)', async () => {
    const r = await send({ type: 'IMPORT_SETTINGS', text: JSON.stringify({ profile: 'god-mode', rules: [{ id: 'x', module: 'nope', effect: 'allow', duration: 'permanent', scope: { kind: 'global' } }], theme: 'neon', sitePolicies: { 'co.uk': 'persistent' } }) });
    assert(r.success, 'import should succeed with sanitised values');
    const s = (await send({ type: 'GET_SETTINGS' })).settings;
    eq([s.profile, s.rules.length, s.theme, Object.keys(s.sitePolicies).length], ['balanced', 0, 'dark', 0], 'sanitised');
  });
  await check('settings: reset restores defaults and releases native settings', async () => {
    await send({ type: 'SET_PROFILE', profile: 'strict' });
    await send({ type: 'RESET_SETTINGS' });
    const g = await browser.privacy.websites.resistFingerprinting.get({});
    eq([g.value, g.levelOfControl], [false, 'controllable_by_this_extension'], 'native released on reset');
    eq((await send({ type: 'GET_SETTINGS' })).settings.profile, 'balanced', 'profile');
  });
}

main()
  .catch((e) => results.push({ name: 'driver crashed', ok: false, detail: String((e as Error)?.stack ?? e) }))
  .finally(async () => {
    await fetch(`${SERVER}/report`, { method: 'POST', body: JSON.stringify({ results }) }).catch(() => undefined);
  });
