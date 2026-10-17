/**
 * Site data policy model (Cookie Vault). Pure functions.
 *
 *   persistent  trusted: never cleaned
 *   session     cleaned on the next browser start (best effort, see queue/startup handling)
 *   ephemeral   cleaned shortly after the last tab of the site (in that container) is closed
 *   restricted  would prevent storing at all. NOT reliably possible with WebExtensions (localStorage/IndexedDB
 *               cannot be blocked) -> accepted as a value but treated like `ephemeral` and flagged in the UI
 */
import { hostMatches, normalizeHost, registrableDomain } from '../../core/domain-utils/domains.ts';
import type { Level } from '../../core/policy-engine/policy.ts';

export type SitePolicy = 'persistent' | 'session' | 'ephemeral' | 'restricted';
export const SITE_POLICIES: readonly SitePolicy[] = ['persistent', 'session', 'ephemeral', 'restricted'];

export const DEFAULT_GRACE_MS = 60_000;
export const MIN_GRACE_MS = 0;
export const MAX_GRACE_MS = 24 * 3600_000;

/** Default policy for sites without an entry, derived from the `cookies` module level. */
export function defaultPolicyForLevel(level: Level): SitePolicy {
  switch (level) {
    case 'strict': return 'session';
    case 'lockdown': return 'ephemeral';
    default: return 'persistent'; // off / balanced: never delete anything unasked
  }
}

export type SitePolicies = Record<string, SitePolicy>;

/**
 * Most specific entry wins: the exact host, then each parent domain, then the default.
 * Entries never match bare public suffixes (hostMatches), so "*.co.uk"-style entries cannot swallow
 * unrelated registrable domains.
 */
export function policyFor(host: string, sites: SitePolicies, fallback: SitePolicy): SitePolicy {
  const h = normalizeHost(host);
  const labels = h.split('.');
  for (let i = 0; i < labels.length; i++) {
    const cand = labels.slice(i).join('.');
    const p = sites[cand];
    if (p && hostMatches(h, cand)) return p;
  }
  return fallback;
}

export function isPersistent(host: string, sites: SitePolicies, fallback: SitePolicy): boolean {
  return policyFor(host, sites, fallback) === 'persistent';
}

export function sanitizeSitePolicies(input: unknown, max = 5000): SitePolicies {
  const out: SitePolicies = {};
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return out;
  let n = 0;
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (n >= max) break;
    const key = normalizeHost(k.replace(/^https?:\/\//i, '').split('/')[0].split(':')[0].replace(/^\*\./, ''));
    if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(key) || !key.includes('.')) continue;
    // a public suffix (e.g. "co.uk") would match unrelated sites
    if (registrableDomain(key) === key && !hostMatches(key, key)) continue;
    if (typeof v === 'string' && (SITE_POLICIES as readonly string[]).includes(v)) { out[key] = v as SitePolicy; n++; }
  }
  return out;
}

export function clampGrace(ms: unknown): number {
  const n = typeof ms === 'number' && Number.isFinite(ms) ? Math.round(ms) : DEFAULT_GRACE_MS;
  return Math.min(MAX_GRACE_MS, Math.max(MIN_GRACE_MS, n));
}
