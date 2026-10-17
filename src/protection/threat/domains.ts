/**
 * Fast, strict parser for domain/hosts blocklists (pure). Lists are DATA: nothing is executed, every entry is validated.
 */
import { hostMatches, registrableDomain } from '../../core/domain-utils/domains.ts';

export const MAX_DOMAINS_PER_LIST = 600_000;

/**
 * Registrable domains that must never be blocked by a downloaded list, whatever the list says. A poisoned or broken
 * feed listing a core site would otherwise turn the protection into a denial of service. Subdomains are dropped too
 * (so malicious hosts on these domains are not covered; documented trade-off).
 */
export const NEVER_BLOCK: ReadonlySet<string> = new Set([
  'mozilla.org', 'mozilla.net', 'mozilla.com', 'firefox.com', 'getpocket.com',
  'google.com', 'gstatic.com', 'googleapis.com', 'googleusercontent.com', 'youtube.com', 'ytimg.com',
  'microsoft.com', 'live.com', 'office.com', 'microsoftonline.com', 'windowsupdate.com', 'apple.com', 'icloud.com',
  'amazon.com', 'cloudflare.com', 'github.com', 'githubusercontent.com', 'wikipedia.org', 'wikimedia.org',
  'facebook.com', 'instagram.com', 'whatsapp.com', 'paypal.com', 'letsencrypt.org', 'digicert.com'
]);

const NAME = /^(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?\.)+[a-z0-9-]{2,63}$/;
const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;

function validIpv4(h: string): boolean {
  return IPV4.test(h) && h.split('.').every((o) => Number(o) <= 255) && !h.startsWith('0.') && h !== '255.255.255.255';
}

export interface ParsedDomains {
  domains: string[];
  invalid: number;
  droppedNeverBlock: number;
  truncated: boolean;
  metadata: { title?: string; updated?: string; expires?: string };
}

export function parseDomainEntries(text: string, max = MAX_DOMAINS_PER_LIST): ParsedDomains {
  const out: ParsedDomains = { domains: [], invalid: 0, droppedNeverBlock: 0, truncated: false, metadata: {} };
  const seen = new Set<string>();
  let lineStart = 0;
  while (lineStart <= text.length) {
    let lineEnd = text.indexOf('\n', lineStart);
    if (lineEnd === -1) lineEnd = text.length;
    let line = text.slice(lineStart, lineEnd).trim();
    lineStart = lineEnd + 1;
    if (!line) continue;
    if (line[0] === '#' || line[0] === '!') {
      const m = line.match(/^[#!]\s*(Title|Updated|Last updated|Expires)\s*:\s*(.+)$/i);
      if (m) {
        const k = m[1].toLowerCase();
        if (k === 'title') out.metadata.title = m[2].slice(0, 120);
        else if (k === 'expires') out.metadata.expires = m[2].slice(0, 60);
        else out.metadata.updated = m[2].slice(0, 60);
      }
      continue;
    }
    const hash = line.indexOf(' #');
    if (hash !== -1) line = line.slice(0, hash).trim();
    const parts = line.split(/\s+/);
    // hosts-file format: "0.0.0.0 evil.example"
    let host = parts.length >= 2 && /^(0\.0\.0\.0|127\.0\.0\.1|::1?)$/.test(parts[0]) ? parts[1] : parts[0];
    host = host.toLowerCase().replace(/\.$/, '');
    if (host.length > 253 || !(validIpv4(host) || NAME.test(host))) { out.invalid++; continue; }
    if (!IPV4.test(host) && !hostMatches(host, host)) { out.invalid++; continue; } // a bare public suffix would block unrelated sites
    if (!IPV4.test(host) && NEVER_BLOCK.has(registrableDomain(host))) { out.droppedNeverBlock++; continue; }
    if (seen.has(host)) continue;
    if (out.domains.length >= max) { out.truncated = true; break; }
    seen.add(host);
    out.domains.push(host);
  }
  return out;
}
