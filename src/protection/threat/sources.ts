/**
 * Malware / phishing domain lists. Same rules as the adblock lists: allowlist only, HTTPS only, opt-in (all off by
 * default), nothing bundled, downloaded straight from the provider by the user's browser. Matching is done LOCALLY
 * (declarativeNetRequest): no visited URL, hash or prefix ever leaves the browser (no Safe-Browsing-style lookup).
 *
 * Licensing is documented honestly in docs/architecture/threat-lists.md; two of these sources are third-party data with
 * their own terms and must be re-checked before any release.
 */
import type { ListSource } from '../adblock/sources.ts';
import { isUrlAllowedForSource } from '../adblock/sources.ts';

export type ThreatKind = 'malware' | 'phishing';

export interface ThreatSource extends ListSource {
  kind: ThreatKind;
  /** Default update interval; phishing domains live for hours, so this is shorter than for adblock lists. */
  defaultIntervalMs: number;
  approxEntries: number;
}

const H12 = 12 * 3600_000;

export const THREAT_SOURCES: readonly ThreatSource[] = [
  {
    id: 'urlhaus-online', kind: 'malware', name: 'Malware – aktive Domains (URLhaus via malware-filter)',
    url: 'https://malware-filter.gitlab.io/malware-filter/urlhaus-filter-domains-online.txt',
    allowedHosts: ['malware-filter.gitlab.io'], format: 'domains',
    license: 'Filterlisten-Repository: MIT und CC0 (laut Repository); Daten: abuse.ch URLhaus (kostenlos nach „Fair Use“, siehe abuse.ch/terms-of-use, nicht von uns geprüft)',
    attribution: 'malware-filter (Ming Di Leom), Daten von abuse.ch URLhaus',
    maxBytes: 2 * 1024 * 1024, description: 'Aktive Malware-Verteilungs-Domains (~2 000 Einträge, klein)', defaultIntervalMs: H12, approxEntries: 2000
  },
  {
    id: 'phishing-filter', kind: 'phishing', name: 'Phishing – Domains (malware-filter)',
    url: 'https://malware-filter.gitlab.io/malware-filter/phishing-filter-domains.txt',
    allowedHosts: ['malware-filter.gitlab.io'], format: 'domains',
    license: 'Filter: CC BY-SA 4.0 (Namensnennung, Weitergabe unter gleichen Bedingungen); Quellen: OpenPhish (kostenlos laut deren Bedingungen), IPThreat (CC BY-SA 4.0), PhishTank',
    attribution: 'malware-filter (Ming Di Leom); OpenPhish, IPThreat, PhishTank',
    maxBytes: 4 * 1024 * 1024, description: 'Phishing-Domains (~30 000 Einträge)', defaultIntervalMs: H12, approxEntries: 30000
  },
  {
    id: 'phishing-database', kind: 'phishing', name: 'Phishing – Phishing.Database (aktive Domains, groß)',
    url: 'https://raw.githubusercontent.com/Phishing-Database/Phishing.Database/master/phishing-domains-ACTIVE.txt',
    allowedHosts: ['raw.githubusercontent.com'], format: 'domains',
    license: 'MIT (Phishing.Database Contributors)',
    attribution: 'Phishing.Database (Mitchell Krog, Nissar Chababy, Contributors)',
    maxBytes: 20 * 1024 * 1024, description: 'Sehr große Liste (~390 000 Einträge, ~11 MB pro Aktualisierung)', defaultIntervalMs: 24 * 3600_000, approxEntries: 390000
  }
];

export function getThreatSource(id: string): ThreatSource | undefined {
  return THREAT_SOURCES.find((s) => s.id === id);
}

export { isUrlAllowedForSource };
