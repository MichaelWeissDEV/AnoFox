/**
 * AnoFox Ephemeral Privacy Statistics & Blocked Insights Manager
 *
 * CRITICAL PRIVACY ASSURANCES:
 * - 100% local and strictly ephemeral (stored only in volatile memory / RAM).
 * - OFF by default (enabled: false).
 * - When disabled, absolutely NOTHING is tracked, counted, or stored.
 * - NEVER persisted to storage across browser sessions or restarts.
 * - Wiped immediately when disabled or when manually cleared.
 */

export interface BlockedItemRecord {
  id: number;
  timestamp: number;
  timeFormatted: string;
  type: 'TRACKING_PARAM' | 'SOCIAL_EMBED';
  sourceSite: string;
  target: string;
  details: string;
  rawParams?: string[];
  providerId?: string;
}

export interface StatisticsSnapshot {
  enabled: boolean;
  totalBlocked: number;
  totalCleanedUrls: number;
  totalRemovedParams: number;
  totalBlockedEmbeds: number;
  paramsBreakdown: Record<string, number>;
  providersBreakdown: Record<string, number>;
  recentBlockedItems: BlockedItemRecord[];
  sessionStartedAt: number;
}

export class PrivacyStatsManager {
  private enabled: boolean = false;
  private totalCleanedUrls: number = 0;
  private totalRemovedParams: number = 0;
  private totalBlockedEmbeds: number = 0;
  private paramsBreakdown: Record<string, number> = {};
  private providersBreakdown: Record<string, number> = {};
  private recentBlockedItems: BlockedItemRecord[] = [];
  private sessionStartedAt: number = Date.now();
  private nextItemId: number = 1;
  private readonly maxRecentItems: number = 60;

  constructor(initialEnabled: boolean = false) {
    this.enabled = initialEnabled;
  }

  /**
   * Sets whether temporary statistics are active.
   * If toggled to false, all data in memory is purged immediately.
   */
  public setEnabled(enabled: boolean): void {
    if (this.enabled && !enabled) {
      this.clear();
    }
    this.enabled = enabled;
    if (enabled && this.sessionStartedAt === 0) {
      this.sessionStartedAt = Date.now();
    }
  }

  public isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Records a URL cleaning event.
   * Does nothing if statistics are disabled.
   */
  public recordUrlCleaned(site: string, rawUrl: string, removedParams: string[]): void {
    if (!this.enabled || removedParams.length === 0) {
      return;
    }

    this.totalCleanedUrls += 1;
    this.totalRemovedParams += removedParams.length;

    for (const param of removedParams) {
      const lower = param.toLowerCase();
      this.paramsBreakdown[lower] = (this.paramsBreakdown[lower] || 0) + 1;
    }

    let displayTarget = site;
    try {
      const parsed = new URL(rawUrl);
      displayTarget = `${parsed.hostname}${parsed.pathname}`;
    } catch {
      // Keep site
    }

    const now = new Date();
    const timeFormatted = now.toTimeString().split(' ')[0] || '';

    const record: BlockedItemRecord = {
      id: this.nextItemId++,
      timestamp: Date.now(),
      timeFormatted,
      type: 'TRACKING_PARAM',
      sourceSite: site || 'Unbekannt',
      target: displayTarget,
      details: `${removedParams.length} Parameter entfernt: ${removedParams.join(', ')}`,
      rawParams: [...removedParams]
    };

    this.recentBlockedItems.unshift(record);
    if (this.recentBlockedItems.length > this.maxRecentItems) {
      this.recentBlockedItems.length = this.maxRecentItems;
    }
  }

  /**
   * Records a blocked social embed event.
   * Does nothing if statistics are disabled.
   */
  public recordEmbedBlocked(providerName: string, providerId: string, site: string, url?: string): void {
    if (!this.enabled) {
      return;
    }

    this.totalBlockedEmbeds += 1;
    const key = providerId || providerName.toLowerCase();
    this.providersBreakdown[key] = (this.providersBreakdown[key] || 0) + 1;

    const now = new Date();
    const timeFormatted = now.toTimeString().split(' ')[0] || '';

    const record: BlockedItemRecord = {
      id: this.nextItemId++,
      timestamp: Date.now(),
      timeFormatted,
      type: 'SOCIAL_EMBED',
      sourceSite: site || 'Unbekannt',
      target: providerName,
      details: `${providerName}-Inhalt blockiert vor Netzwerkverbindung`,
      providerId: key
    };

    this.recentBlockedItems.unshift(record);
    if (this.recentBlockedItems.length > this.maxRecentItems) {
      this.recentBlockedItems.length = this.maxRecentItems;
    }
  }

  /**
   * Retrieves an immutable snapshot of current session statistics.
   */
  public getStats(): StatisticsSnapshot {
    return {
      enabled: this.enabled,
      totalBlocked: this.totalRemovedParams + this.totalBlockedEmbeds,
      totalCleanedUrls: this.totalCleanedUrls,
      totalRemovedParams: this.totalRemovedParams,
      totalBlockedEmbeds: this.totalBlockedEmbeds,
      paramsBreakdown: { ...this.paramsBreakdown },
      providersBreakdown: { ...this.providersBreakdown },
      recentBlockedItems: [...this.recentBlockedItems],
      sessionStartedAt: this.sessionStartedAt
    };
  }

  /**
   * Clears all in-memory statistics and history.
   */
  public clear(): void {
    this.totalCleanedUrls = 0;
    this.totalRemovedParams = 0;
    this.totalBlockedEmbeds = 0;
    this.paramsBreakdown = {};
    this.providersBreakdown = {};
    this.recentBlockedItems = [];
    this.sessionStartedAt = Date.now();
  }
}

export const privacyStats = new PrivacyStatsManager(false);
