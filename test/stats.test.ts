import test from 'node:test';
import assert from 'node:assert/strict';
import { PrivacyStatsManager } from '../src/stats.ts';

test('PrivacyStatsManager is disabled by default and records nothing', () => {
  const stats = new PrivacyStatsManager(false);
  assert.equal(stats.isEnabled(), false);

  stats.recordUrlCleaned('example.com', 'https://example.com?utm_source=ad', ['utm_source']);
  stats.recordEmbedBlocked('YouTube', 'youtube', 'news.org', 'https://youtube.com/embed/123');

  const snapshot = stats.getStats();
  assert.equal(snapshot.enabled, false);
  assert.equal(snapshot.totalBlocked, 0);
  assert.equal(snapshot.totalCleanedUrls, 0);
  assert.equal(snapshot.totalRemovedParams, 0);
  assert.equal(snapshot.totalBlockedEmbeds, 0);
  assert.equal(snapshot.recentBlockedItems.length, 0);
});

test('PrivacyStatsManager records in-memory data when enabled', () => {
  const stats = new PrivacyStatsManager(true);
  assert.equal(stats.isEnabled(), true);

  stats.recordUrlCleaned('example.com', 'https://example.com/item?utm_source=test&fbclid=abc', ['utm_source', 'fbclid']);
  stats.recordEmbedBlocked('YouTube', 'youtube', 'blog.org');
  stats.recordEmbedBlocked('Instagram', 'instagram', 'blog.org');

  const snapshot = stats.getStats();
  assert.equal(snapshot.enabled, true);
  assert.equal(snapshot.totalCleanedUrls, 1);
  assert.equal(snapshot.totalRemovedParams, 2);
  assert.equal(snapshot.totalBlockedEmbeds, 2);
  assert.equal(snapshot.totalBlocked, 4); // 2 params + 2 embeds

  assert.equal(snapshot.paramsBreakdown['utm_source'], 1);
  assert.equal(snapshot.paramsBreakdown['fbclid'], 1);
  assert.equal(snapshot.providersBreakdown['youtube'], 1);
  assert.equal(snapshot.providersBreakdown['instagram'], 1);

  assert.equal(snapshot.recentBlockedItems.length, 3);
  assert.equal(snapshot.recentBlockedItems[0].type, 'SOCIAL_EMBED');
  assert.equal(snapshot.recentBlockedItems[0].target, 'Instagram');
});

test('PrivacyStatsManager completely purges memory when disabled or cleared', () => {
  const stats = new PrivacyStatsManager(true);
  stats.recordUrlCleaned('example.com', 'https://example.com?utm_source=test', ['utm_source']);
  assert.equal(stats.getStats().totalCleanedUrls, 1);

  // Toggle off: must immediately wipe all collected data
  stats.setEnabled(false);
  const snapshotAfterOff = stats.getStats();
  assert.equal(snapshotAfterOff.enabled, false);
  assert.equal(snapshotAfterOff.totalBlocked, 0);
  assert.equal(snapshotAfterOff.totalCleanedUrls, 0);
  assert.equal(snapshotAfterOff.recentBlockedItems.length, 0);

  // Further records when off do nothing
  stats.recordUrlCleaned('example.com', 'https://example.com?utm_source=test', ['utm_source']);
  assert.equal(stats.getStats().totalCleanedUrls, 0);

  // Manual clear works when on
  stats.setEnabled(true);
  stats.recordEmbedBlocked('TikTok', 'tiktok', 'site.com');
  assert.equal(stats.getStats().totalBlockedEmbeds, 1);
  stats.clear();
  assert.equal(stats.getStats().totalBlockedEmbeds, 0);
});
