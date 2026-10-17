/** Pure domain helpers shared by background and UI. */

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
      result.add(cleaned);
    }
  }
  return Array.from(result);
}

/**
 * Multi-label public suffixes known to this build. This is a deliberately small
 * STOPGAP until the Public Suffix List is bundled (tracked in capabilities.md);
 * unknown multi-label suffixes degrade to "last two labels" which can over-match,
 * so callers that delete data or grant access must treat results as best effort.
 */
const MULTI_LABEL_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'com.au', 'net.au', 'org.au', 'edu.au',
  'co.jp', 'ne.jp', 'or.jp', 'co.nz', 'co.za', 'com.br', 'com.cn', 'com.mx', 'co.in', 'co.kr',
  'github.io', 'gitlab.io', 'netlify.app', 'vercel.app', 'pages.dev', 'herokuapp.com',
  'blogspot.com', 'appspot.com', 'cloudfront.net', 's3.amazonaws.com'
]);

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

export function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, '');
}

/** eTLD+1 approximation (see MULTI_LABEL_SUFFIXES). IPs and single labels are returned unchanged. */
export function registrableDomain(host: string): string {
  const h = normalizeHost(host);
  if (!h || IPV4.test(h) || h.includes(':') || !h.includes('.')) return h;
  const labels = h.split('.');
  for (const take of [3, 2]) {
    if (labels.length > take && MULTI_LABEL_SUFFIXES.has(labels.slice(-take).join('.'))) {
      return labels.slice(-(take + 1)).join('.');
    }
  }
  return labels.slice(-2).join('.');
}

export function isThirdParty(topHost: string, targetHost: string): boolean {
  return registrableDomain(topHost) !== registrableDomain(targetHost);
}

/** True if host equals `pattern` or is a subdomain of it. Patterns that are bare public suffixes never match. */
export function hostMatches(host: string, pattern: string): boolean {
  const h = normalizeHost(host);
  const p = normalizeHost(pattern).replace(/^\*\./, '');
  if (!p || MULTI_LABEL_SUFFIXES.has(p) || !p.includes('.')) return false;
  return h === p || h.endsWith('.' + p);
}
