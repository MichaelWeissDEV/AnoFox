/**
 * Browser-facing part of the Cookie Vault / Privacy Storage Manager.
 * Tracks tabs (state kept in storage.session because the event page can be suspended at any time), records
 * cleanup intentions in storage.local, and executes them through the pure planner in protection/storage.
 */
import type { AnoFoxSettings } from '../../core/settings/settings.ts';
import { effectiveLevels } from '../../core/policy-engine/policy.ts';
import { registrableDomain } from '../../core/domain-utils/domains.ts';
import { defaultPolicyForLevel, policyFor } from '../../protection/storage/model.ts';
import type { SitePolicy } from '../../protection/storage/model.ts';
import { planCleanup, executeCleanup } from '../../protection/storage/cleaner.ts';
import type { StorageApi, CookieLike, OpenTab, CleanupContext } from '../../protection/storage/cleaner.ts';
import { enqueue, cancelFor, due, complete, fail, pruneStale } from '../../protection/storage/queue.ts';
import type { CleanupIntent } from '../../protection/storage/queue.ts';
import { logger } from '../../logger.ts';

const KEY_QUEUE = 'storage:queue';
const KEY_HOSTS = 'storage:hosts'; // site -> hostnames seen (only sites that may need cleaning)
const KEY_RESULTS = 'storage:results';
const KEY_TABS = 'storage:tabs'; // storage.session: tabId -> {host, storeId}
const DEFAULT_STORE = 'firefox-default';
const MAX_RESULTS = 30;
const MAX_HOSTS_PER_SITE = 50;
const MAX_SITES = 2000;

type TabInfo = { host: string; storeId: string };
export interface StoredResult { site: string; at: number; cookiesRemoved: number; cookiesFailed: number; cookiesRemaining: number; ok: boolean; unverified: string[]; reason: string }

const httpHost = (url: string | undefined): string | null => {
  if (!url) return null;
  try { const u = new URL(url); return u.protocol === 'http:' || u.protocol === 'https:' ? u.hostname.toLowerCase() : null; } catch { return null; }
};

const api: StorageApi = {
  async stores() { return (await browser.cookies.getAllCookieStores()).map((s) => s.id); },
  async getCookies(storeId) {
    const list = await browser.cookies.getAll({ storeId, partitionKey: {} } as never);
    return list.map((c) => ({
      name: c.name, domain: c.domain, path: c.path, secure: c.secure, storeId: c.storeId,
      partitionTopLevelSite: (c as unknown as { partitionKey?: { topLevelSite?: string } }).partitionKey?.topLevelSite ?? null
    }));
  },
  async removeCookie(c: CookieLike) {
    const url = `${c.secure ? 'https' : 'http'}://${c.domain.replace(/^\./, '')}${c.path}`;
    const details: Record<string, unknown> = { url, name: c.name, storeId: c.storeId };
    if (c.partitionTopLevelSite) details.partitionKey = { topLevelSite: c.partitionTopLevelSite };
    return (await browser.cookies.remove(details as never)) !== null;
  },
  async removeData(opts, types) {
    // never pass cookieStoreId together with serviceWorkers/cache (Firefox throws, possibly after partial work)
    const options: Record<string, unknown> = { hostnames: opts.hostnames };
    if (opts.storeId && !types.serviceWorkers) options.cookieStoreId = opts.storeId;
    await browser.browsingData.remove(options as never, types as never);
  }
};

export function createStorageService(getSettings: () => AnoFoxSettings) {
  const local = async <T>(key: string, fallback: T): Promise<T> => ((await browser.storage.local.get(key))[key] as T | undefined) ?? fallback;
  const setLocal = (key: string, value: unknown) => browser.storage.local.set({ [key]: value });
  let serial: Promise<unknown> = Promise.resolve();
  const run = <T>(fn: () => Promise<T>): Promise<T> => { const p = serial.then(fn, fn); serial = p.catch(() => undefined); return p; };

  function config() {
    const s = getSettings();
    const levels = effectiveLevels({ profile: s.profile, customLevels: s.customLevels, rules: [] });
    const lead = levels.cookies !== 'off' ? levels.cookies : levels.storage;
    return {
      sites: s.sitePolicies, graceMs: s.storageGraceMs,
      fallback: defaultPolicyForLevel(lead),
      cleanCookies: levels.cookies !== 'off', cleanData: levels.storage !== 'off',
      active: levels.cookies !== 'off' || levels.storage !== 'off'
    };
  }
  const policyOf = (host: string): SitePolicy => { const c = config(); return policyFor(host, c.sites, c.fallback); };
  const needsCleaning = (host: string): boolean => policyOf(host) !== 'persistent';

  async function openTabs(): Promise<OpenTab[]> {
    const tabs = await browser.tabs.query({});
    const out: OpenTab[] = [];
    for (const t of tabs) {
      const host = httpHost(t.url);
      if (host) out.push({ host, storeId: t.cookieStoreId ?? DEFAULT_STORE, incognito: t.incognito });
    }
    return out;
  }

  async function tabMap(): Promise<Record<string, TabInfo>> {
    return ((await browser.storage.session.get(KEY_TABS))[KEY_TABS] as Record<string, TabInfo> | undefined) ?? {};
  }

  async function recordHost(host: string): Promise<void> {
    const site = registrableDomain(host);
    const hosts = await local<Record<string, string[]>>(KEY_HOSTS, {});
    const list = hosts[site] ?? [];
    if (list.includes(host)) return;
    if (!hosts[site] && Object.keys(hosts).length >= MAX_SITES) return;
    hosts[site] = [...list, host].slice(-MAX_HOSTS_PER_SITE);
    await setLocal(KEY_HOSTS, hosts);
  }

  async function pushResult(r: StoredResult): Promise<void> {
    const list = await local<StoredResult[]>(KEY_RESULTS, []);
    await setLocal(KEY_RESULTS, [r, ...list].slice(0, MAX_RESULTS));
  }

  async function ctxFor(site: string): Promise<CleanupContext> {
    const c = config();
    const hosts = (await local<Record<string, string[]>>(KEY_HOSTS, {}))[site] ?? [];
    return { sites: c.sites, fallback: c.fallback, openTabs: await openTabs(), knownHosts: hosts, cleanCookies: c.cleanCookies, cleanData: c.cleanData };
  }

  async function cleanSite(site: string, storeId: string | undefined, reason: string): Promise<StoredResult | null> {
    const plan = await planCleanup(api, site, await ctxFor(site), storeId);
    if (plan.ops.length === 0) return null;
    const res = await executeCleanup(api, plan);
    const stored: StoredResult = { site, at: Date.now(), cookiesRemoved: res.cookiesRemoved, cookiesFailed: res.cookiesFailed, cookiesRemaining: res.cookiesRemaining, ok: res.ok, unverified: res.unverified, reason };
    await pushResult(stored);
    if (res.ok && !storeId) {
      const hosts = await local<Record<string, string[]>>(KEY_HOSTS, {});
      delete hosts[site];
      await setLocal(KEY_HOSTS, hosts);
    }
    logger.info(`[Storage] ${site}: ${res.cookiesRemoved} Cookies entfernt, ${res.cookiesFailed} fehlgeschlagen, ${res.cookiesRemaining} verbleibend (${reason}).`);
    return stored;
  }

  async function addIntent(site: string, storeId: string | undefined, reason: CleanupIntent['reason'], delayMs: number): Promise<void> {
    const now = Date.now();
    const queue = await local<CleanupIntent[]>(KEY_QUEUE, []);
    await setLocal(KEY_QUEUE, enqueue(pruneStale(queue, now), { site, storeId, reason, dueAt: now + delayMs, createdAt: now }));
  }

  async function processQueue(): Promise<void> {
    let queue = await local<CleanupIntent[]>(KEY_QUEUE, []);
    const now = Date.now();
    for (const intent of due(queue, now)) {
      try {
        const cfg = config();
        if (!cfg.active) { queue = complete(queue, intent.id); continue; }
        await cleanSite(intent.site, intent.storeId, intent.reason);
        queue = complete(queue, intent.id);
      } catch (e) {
        queue = fail(queue, intent.id, now, e instanceof Error ? e.message : String(e));
      }
    }
    await setLocal(KEY_QUEUE, queue);
  }

  return {
    /** tabs.onUpdated: remember the tab's site, cancel pending cleanups for it, schedule cleanup of the site left behind. */
    onTabUpdated: (tabId: number, url: string | undefined, storeId: string | undefined) => run(async () => {
      const host = httpHost(url);
      const map = await tabMap();
      const prev = map[String(tabId)];
      const store = storeId ?? DEFAULT_STORE;
      if (!host) return;
      if (prev && registrableDomain(prev.host) !== registrableDomain(host) && config().active) {
        const p = policyOf(prev.host);
        if (p === 'ephemeral' || p === 'restricted') await addIntent(registrableDomain(prev.host), prev.storeId, 'navigated-away', config().graceMs);
      }
      map[String(tabId)] = { host, storeId: store };
      await browser.storage.session.set({ [KEY_TABS]: map });
      const site = registrableDomain(host);
      if (needsCleaning(host)) await recordHost(host);
      const queue = await local<CleanupIntent[]>(KEY_QUEUE, []);
      const next = cancelFor(queue, site, store);
      if (next.length !== queue.length) await setLocal(KEY_QUEUE, next);
    }),
    onTabRemoved: (tabId: number) => run(async () => {
      const map = await tabMap();
      const prev = map[String(tabId)];
      if (!prev) return;
      delete map[String(tabId)];
      await browser.storage.session.set({ [KEY_TABS]: map });
      if (!config().active) return;
      const p = policyOf(prev.host);
      if (p === 'ephemeral' || p === 'restricted') {
        await addIntent(registrableDomain(prev.host), prev.storeId, 'tab-closed', config().graceMs);
        if (config().graceMs === 0) await processQueue();
      }
    }),
    /** Browser start: everything recorded for session/ephemeral sites is cleaned (best-effort replacement for "on shutdown"). */
    onBrowserStart: () => run(async () => {
      await browser.storage.session.set({ [KEY_TABS]: {} });
      if (!config().active) return;
      const hosts = await local<Record<string, string[]>>(KEY_HOSTS, {});
      for (const [site, list] of Object.entries(hosts)) {
        if (list.some(needsCleaning)) await addIntent(site, undefined, 'startup', 0);
      }
      await processQueue();
    }),
    processQueue: () => run(processQueue),
    cleanNow: (site: string) => run(async () => {
      const s = registrableDomain(site);
      const res = await cleanSite(s, undefined, 'manual');
      return res;
    }),
    async status(host?: string) {
      const cfg = config();
      const queue = await local<CleanupIntent[]>(KEY_QUEUE, []);
      const results = await local<StoredResult[]>(KEY_RESULTS, []);
      let cookies: { total: number; session: number; persistent: number; partitioned: number } | undefined;
      if (host) {
        const site = registrableDomain(host);
        const all: CookieLike[] = [];
        for (const id of await api.stores()) all.push(...(await api.getCookies(id)));
        const mine = all.filter((c) => registrableDomain(c.domain.replace(/^\./, '')) === site || (c.partitionTopLevelSite && registrableDomain(new URL(c.partitionTopLevelSite).hostname) === site));
        const raw = await browser.cookies.getAll({ domain: site });
        const sessionCount = raw.filter((c) => c.session).length;
        cookies = { total: mine.length, session: sessionCount, persistent: raw.length - sessionCount, partitioned: mine.filter((c) => c.partitionTopLevelSite).length };
      }
      return {
        active: cfg.active, graceMs: cfg.graceMs, defaultPolicy: cfg.fallback, policy: host ? policyOf(host) : undefined,
        pending: queue.map((q) => ({ site: q.site, dueAt: q.dueAt, reason: q.reason, attempts: q.attempts, lastError: q.lastError })),
        results: results.slice(0, 10), cookies
      };
    }
  };
}
