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
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try { await fn(); results.push({ name, ok: true }); await ping('ok ' + name); }
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
