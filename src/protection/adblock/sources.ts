/**
 * Built-in filter list sources. This is an ALLOWLIST: AnoFox never downloads from a URL that is not
 * listed here (no custom lists in this version; adding one would be an explicit, separate feature).
 * Lists are opt-in; every entry is disabled by default.
 */
import type { ListFormat } from './parser.ts';

export interface ListSource {
  id: string;
  name: string;
  url: string;
  /** Hosts the response may come from after redirects. */
  allowedHosts: string[];
  format: ListFormat;
  license: string;
  attribution: string;
  /** Hard download cap (bytes) */
  maxBytes: number;
  description: string;
}

export const LIST_SOURCES: readonly ListSource[] = [
  {
    id: 'easylist', name: 'EasyList', url: 'https://easylist.to/easylist/easylist.txt',
    allowedHosts: ['easylist.to', 'easylist-downloads.adblockplus.org'], format: 'abp',
    license: 'GPL-3.0-or-later OR CC-BY-SA-3.0-or-later', attribution: 'The EasyList authors (https://easylist.to/)',
    maxBytes: 8 * 1024 * 1024, description: 'Werbung (international)'
  },
  {
    id: 'easyprivacy', name: 'EasyPrivacy', url: 'https://easylist.to/easylist/easyprivacy.txt',
    allowedHosts: ['easylist.to', 'easylist-downloads.adblockplus.org'], format: 'abp',
    license: 'GPL-3.0-or-later OR CC-BY-SA-3.0-or-later', attribution: 'The EasyList authors (https://easylist.to/)',
    maxBytes: 6 * 1024 * 1024, description: 'Tracker und Analyse'
  },
  {
    id: 'adguard-base', name: 'AdGuard Base', url: 'https://filters.adtidy.org/extension/ublock/filters/2.txt',
    allowedHosts: ['filters.adtidy.org'], format: 'abp',
    license: 'GPL-3.0 (laut Drittquellen; vor Release am Repository prüfen)', attribution: 'AdGuard Software Ltd',
    maxBytes: 14 * 1024 * 1024, description: 'Werbung (AdGuard Base, viele nicht unterstützte Regeln)'
  }
];

export function getSource(id: string): ListSource | undefined {
  return LIST_SOURCES.find((s) => s.id === id);
}

/** Validates that a URL is HTTPS, credential-free, default-port and on the source's host allowlist. */
export function isUrlAllowedForSource(url: string, source: ListSource): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return false;
  const host = u.hostname.toLowerCase();
  return source.allowedHosts.includes(host);
}
