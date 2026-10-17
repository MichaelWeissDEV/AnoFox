/**
 * Site data cleanup: planning (pure) and execution (via injected API).
 *
 * Reach facts this design is built on (measured in Firefox 158, see docs/architecture/storage-reach.md):
 *  - cookies API enumerates partitioned cookies only with `partitionKey: {}`; `remove` needs the same partitionKey
 *  - browsingData `hostnames`: cookies = exact host + domain cookies of that name (not other subdomains' host-only
 *    cookies); localStorage/IndexedDB = exact origin host; serviceWorkers = host AND its subdomains
 *  - `cookieStoreId` works for cookies/localStorage/IndexedDB, but NOT for serviceWorkers/cache (call throws)
 *  - clearing a top-level site does not clear third-party storage partitioned under it (only cookies, via
 *    partitionKey); clearing the third party's own host clears all of its partitions
 *  - hostnames filters do not match origins on non-default ports
 *  - CacheStorage cannot be cleared by browsingData at all
 */
import { registrableDomain, normalizeHost } from '../../core/domain-utils/domains.ts';
import { policyFor } from './model.ts';
import type { SitePolicies, SitePolicy } from './model.ts';

export interface CookieLike {
  name: string;
  domain: string;
  path: string;
  secure: boolean;
  storeId: string;
  /** topLevelSite like "https://example.com" (no port) for partitioned cookies, undefined/null otherwise */
  partitionTopLevelSite?: string | null;
}

export interface OpenTab { host: string; storeId: string; incognito?: boolean }

export interface StorageApi {
  stores(): Promise<string[]>;
  /** All cookies of a store INCLUDING partitioned ones. */
  getCookies(storeId: string): Promise<CookieLike[]>;
  removeCookie(c: CookieLike): Promise<boolean>;
  removeData(opts: { hostnames: string[]; storeId?: string }, types: { cookies?: boolean; localStorage?: boolean; indexedDB?: boolean; serviceWorkers?: boolean }): Promise<void>;
}

export interface CleanupContext {
  sites: SitePolicies;
  fallback: SitePolicy;
  openTabs: OpenTab[];
  /** Hostnames of this site seen in earlier visits (needed for localStorage/IndexedDB, which cannot be enumerated). */
  knownHosts: string[];
  cleanCookies: boolean;
  cleanData: boolean;
}

export type CleanOp =
  | { kind: 'cookie'; cookie: CookieLike }
  | { kind: 'data'; hostnames: string[]; storeId: string; types: { localStorage?: boolean; indexedDB?: boolean } }
  | { kind: 'serviceWorkers'; hostnames: string[] };

export interface SkipNote { code: 'trusted' | 'in-use' | 'in-use-other-store' | 'nothing-to-do' | 'disabled'; storeId?: string; host?: string }

export interface CleanupPlan {
  site: string;
  ops: CleanOp[];
  skipped: SkipNote[];
  /** Things this plan knowingly cannot do; shown to the user. */
  limitations: string[];
}

const siteOfCookie = (c: CookieLike): string => registrableDomain(c.domain.replace(/^\./, ''));

/**
 * Builds the list of deletions for one registrable domain (`site`), optionally restricted to one store.
 * Safety rules: persistent hosts are never touched; a store with an open tab of the site is skipped;
 * service workers (not container-scoped) are removed only if the site is open in NO store.
 */
export async function planCleanup(api: StorageApi, site: string, ctx: CleanupContext, onlyStore?: string): Promise<CleanupPlan> {
  const plan: CleanupPlan = { site, ops: [], skipped: [], limitations: [] };
  if (!ctx.cleanCookies && !ctx.cleanData) { plan.skipped.push({ code: 'disabled' }); return plan; }
  const siteKey = registrableDomain(site);
  const isCleanable = (host: string): boolean => policyFor(host, ctx.sites, ctx.fallback) !== 'persistent';

  const openAnywhere = ctx.openTabs.some((t) => registrableDomain(t.host) === siteKey);
  const stores = onlyStore ? [onlyStore] : await api.stores();
  const hostSet = new Set(ctx.knownHosts.map(normalizeHost).filter((h) => registrableDomain(h) === siteKey));
  const trustedHosts = new Set<string>();

  for (const storeId of stores) {
    if (ctx.openTabs.some((t) => t.storeId === storeId && registrableDomain(t.host) === siteKey)) {
      plan.skipped.push({ code: 'in-use', storeId });
      continue;
    }
    const cookies = await api.getCookies(storeId);
    const dataHosts = new Set(hostSet);
    for (const c of cookies) {
      const host = normalizeHost(c.domain.replace(/^\./, ''));
      if (siteOfCookie(c) === siteKey && !c.partitionTopLevelSite) dataHosts.add(host);
      // a third-party cookie living in this site's partition belongs to this site's browsing context
      const inPartitionOfSite = c.partitionTopLevelSite
        ? registrableDomain(new URL(c.partitionTopLevelSite).hostname) === siteKey : false;
      const firstParty = siteOfCookie(c) === siteKey && !c.partitionTopLevelSite;
      if (!(firstParty || inPartitionOfSite)) continue;
      if (!ctx.cleanCookies) continue;
      // policy is decided by the site the cookie lives under (its partition's top-level site if partitioned)
      const policyHost = inPartitionOfSite && !firstParty ? new URL(c.partitionTopLevelSite as string).hostname : host;
      if (!isCleanable(policyHost)) { trustedHosts.add(policyHost); continue; }
      plan.ops.push({ kind: 'cookie', cookie: c });
    }
    if (ctx.cleanData) {
      const cleanableHosts = [...dataHosts].filter((h) => { const ok = isCleanable(h); if (!ok) trustedHosts.add(h); return ok; });
      if (cleanableHosts.length) {
        plan.ops.push({ kind: 'data', hostnames: cleanableHosts, storeId, types: { localStorage: true, indexedDB: true } });
      }
    }
  }
  for (const h of trustedHosts) plan.skipped.push({ code: 'trusted', host: h });

  if (ctx.cleanData) {
    const swHosts = [...hostSet].filter(isCleanable);
    if (openAnywhere) plan.skipped.push({ code: 'in-use-other-store' });
    else if (stores.length > 0 && trustedHosts.size === 0 && swHosts.length > 0) plan.ops.push({ kind: 'serviceWorkers', hostnames: [siteKey, ...swHosts.filter((h) => h !== siteKey)] });
    // removal by hostname also removes service workers of subdomains: with a trusted host in the site we skip entirely
    else if (trustedHosts.size > 0 && swHosts.length > 0) plan.limitations.push('Service Worker nicht entfernt: Website enthält vertrauenswürdige Subdomains (Entfernung per Hostname trifft Subdomains)');
  }
  if (ctx.cleanData) {
    plan.limitations.push('CacheStorage ist nicht entfernbar (kein browsingData-Typ).');
    plan.limitations.push('Gespeicherte Daten von Drittanbietern unter dieser Website (localStorage/IndexedDB) sind nicht gezielt entfernbar.');
    plan.limitations.push('Daten auf nicht-Standard-Ports werden von der Hostname-Entfernung nicht erfasst.');
  }
  if (plan.ops.length === 0 && plan.skipped.length === 0) plan.skipped.push({ code: 'nothing-to-do' });
  return plan;
}

export interface CleanupResult {
  site: string;
  cookiesRemoved: number;
  cookiesFailed: number;
  /** cookies still present after the run although they were targeted */
  cookiesRemaining: number;
  dataOps: Array<{ kind: 'data' | 'serviceWorkers'; ok: boolean; error?: string }>;
  /** What could not be verified (localStorage/IndexedDB/service workers have no read API). */
  unverified: string[];
  ok: boolean;
}

/**
 * Executes a plan. Per-operation errors never abort the others; cookies are verified by re-reading them.
 * Never records cookie names or values.
 */
export async function executeCleanup(api: StorageApi, plan: CleanupPlan): Promise<CleanupResult> {
  const res: CleanupResult = { site: plan.site, cookiesRemoved: 0, cookiesFailed: 0, cookiesRemaining: 0, dataOps: [], unverified: [], ok: true };
  const targeted = new Map<string, CookieLike[]>();
  for (const op of plan.ops) {
    if (op.kind === 'cookie') {
      let ok = false;
      try { ok = await api.removeCookie(op.cookie); } catch { ok = false; }
      if (ok) res.cookiesRemoved++; else res.cookiesFailed++;
      const list = targeted.get(op.cookie.storeId) ?? [];
      list.push(op.cookie);
      targeted.set(op.cookie.storeId, list);
    } else if (op.kind === 'data') {
      try { await api.removeData({ hostnames: op.hostnames, storeId: op.storeId }, op.types); res.dataOps.push({ kind: 'data', ok: true }); res.unverified.push(`localStorage/IndexedDB (${op.hostnames.length} Host(s))`); }
      catch (e) { res.dataOps.push({ kind: 'data', ok: false, error: e instanceof Error ? e.message : String(e) }); }
    } else {
      try { await api.removeData({ hostnames: op.hostnames }, { serviceWorkers: true }); res.dataOps.push({ kind: 'serviceWorkers', ok: true }); res.unverified.push('Service Worker'); }
      catch (e) { res.dataOps.push({ kind: 'serviceWorkers', ok: false, error: e instanceof Error ? e.message : String(e) }); }
    }
  }
  // verify cookies by re-reading
  const key = (c: CookieLike) => [c.storeId, c.domain, c.path, c.name, c.partitionTopLevelSite ?? ''].join('|');
  for (const [storeId, list] of targeted) {
    try {
      const now = new Set((await api.getCookies(storeId)).map(key));
      res.cookiesRemaining += list.filter((c) => now.has(key(c))).length;
    } catch { res.cookiesRemaining += list.length; }
  }
  res.ok = res.cookiesFailed === 0 && res.cookiesRemaining === 0 && res.dataOps.every((d) => d.ok);
  return res;
}
