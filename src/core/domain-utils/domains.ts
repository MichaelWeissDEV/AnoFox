/** Pure domain helpers shared by background and UI. */

import { PSL_NORMAL, PSL_WILDCARD, PSL_EXCEPTION } from './psl-data.ts';

/**
 * Sanitizes domain exceptions into valid domain strings (e.g. removing protocols, paths, wildcards).
 */
export function sanitizeDomainList(domains: string[]): string[] {
  const result = new Set<string>();
  for (const raw of domains) {
    let cleaned = raw.trim().toLowerCase();
    if (!cleaned) continue;

    // Remove http:// or https:// if user pasted a full URL
    cleaned = cleaned.replace(/^https?:\/\//i, '');
    // Remove port and path
    cleaned = cleaned.split('/')[0].split(':')[0];
    // Remove leading wildcard *.
    cleaned = cleaned.replace(/^\*\./, '');

    if (cleaned.length > 0 && cleaned.includes('.')) {
      result.add(normalizeHost(cleaned)); // IDN input becomes punycode, like URL.hostname
    }
  }
  return Array.from(result);
}

/**
 * Public Suffix List lookup (https://publicsuffix.org/, MPL-2.0; data in psl-data.ts, generated from vendor/psl).
 * Implements the PSL algorithm: exception rules win, otherwise the longest matching normal/wildcard rule, otherwise the
 * default rule "*" (the last label). ICANN and PRIVATE sections are both included on purpose: user-content hosts such as
 * github.io or blogspot.com are site boundaries for cookies, storage and third-party decisions.
 */
let normalSet: Set<string> | null = null;
let wildcardSet: Set<string> | null = null;
let exceptionSet: Set<string> | null = null;
function sets(): { normal: Set<string>; wildcard: Set<string>; exception: Set<string> } {
  normalSet ??= new Set(PSL_NORMAL.split(' '));
  wildcardSet ??= new Set(PSL_WILDCARD.split(' '));
  exceptionSet ??= new Set(PSL_EXCEPTION.split(' '));
  return { normal: normalSet, wildcard: wildcardSet, exception: exceptionSet };
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

export function normalizeHost(host: string): string {
  let h = host.trim().toLowerCase().replace(/\.$/, '');
  // Unicode (IDN) input becomes its punycode form, the same form URL.hostname delivers
  if (/[^\x00-\x7f]/.test(h)) {
    try { h = new URL(`http://${h}`).hostname; } catch { /* keep as typed */ }
  }
  return h;
}

function isIpLike(h: string): boolean {
  return IPV4.test(h) || h.includes(':') || h.startsWith('[');
}

/** The public suffix of a host (e.g. "co.uk", "github.io"); for IPs and single labels the host itself. */
export function publicSuffix(host: string): string {
  const h = normalizeHost(host);
  if (!h || isIpLike(h) || !h.includes('.')) return h;
  const labels = h.split('.');
  const { normal, wildcard, exception } = sets();
  for (let i = 0; i < labels.length; i++) {
    if (exception.has(labels.slice(i).join('.'))) return labels.slice(i + 1).join('.');
  }
  let best = 1; // default rule "*"
  for (let i = 0; i < labels.length; i++) {
    const len = labels.length - i;
    if (len <= best) continue;
    if (normal.has(labels.slice(i).join('.'))) best = len;
    else if (len >= 2 && wildcard.has(labels.slice(i + 1).join('.'))) best = len;
  }
  return labels.slice(labels.length - best).join('.');
}

export function isPublicSuffix(host: string): boolean {
  const h = normalizeHost(host);
  return !!h && !isIpLike(h) && publicSuffix(h) === h;
}

/** eTLD+1 per the Public Suffix List. IPs, single labels and hosts that ARE a public suffix are returned unchanged. */
export function registrableDomain(host: string): string {
  const h = normalizeHost(host);
  if (!h || isIpLike(h) || !h.includes('.')) return h;
  const suffix = publicSuffix(h);
  if (suffix === h) return h;
  const labels = h.split('.');
  return labels.slice(labels.length - suffix.split('.').length - 1).join('.');
}

export function isThirdParty(topHost: string, targetHost: string): boolean {
  return registrableDomain(topHost) !== registrableDomain(targetHost);
}

/** True if host equals `pattern` or is a subdomain of it. Patterns that are public suffixes or single labels never match. */
export function hostMatches(host: string, pattern: string): boolean {
  const h = normalizeHost(host);
  const p = normalizeHost(pattern).replace(/^\*\./, '');
  if (!p || !p.includes('.') || isPublicSuffix(p)) return false;
  return h === p || h.endsWith('.' + p);
}
