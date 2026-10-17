import test from 'node:test';
import assert from 'node:assert/strict';
import {
  identifyEmbedProvider,
  isEmbedUrl,
  SUPPORTED_EMBED_PROVIDERS,
  DEFAULT_PROVIDERS
} from '../src/embed-guard.ts';
import {
  buildDnrRules,
  DNR_RULE_BLOCK_EMBED_BASE,
  DNR_RULE_REDIRECT_TRACKING
} from '../src/dnr-manager.ts';

test('identifyEmbedProvider correctly identifies YouTube embeds', () => {
  assert.equal(identifyEmbedProvider('https://www.youtube.com/embed/dQw4w9WgXcQ')?.id, 'youtube');
  assert.equal(identifyEmbedProvider('https://youtube-nocookie.com/embed/dQw4w9WgXcQ')?.id, 'youtube');
  assert.equal(identifyEmbedProvider('https://youtube.com/watch?v=dQw4w9WgXcQ'), null);
});

test('identifyEmbedProvider correctly identifies Instagram embeds', () => {
  assert.equal(identifyEmbedProvider('https://www.instagram.com/p/C123456/embed/captioned')?.id, 'instagram');
  assert.equal(identifyEmbedProvider('https://instagram.com/reel/C789/embed')?.id, 'instagram');
  assert.equal(identifyEmbedProvider('https://www.instagram.com/embed.js')?.id, 'instagram');
  assert.equal(identifyEmbedProvider('https://instagram.com/explore'), null);
});

test('identifyEmbedProvider correctly identifies TikTok embeds', () => {
  assert.equal(identifyEmbedProvider('https://www.tiktok.com/embed/v2/123456789')?.id, 'tiktok');
  assert.equal(identifyEmbedProvider('https://www.tiktok.com/embed.js')?.id, 'tiktok');
  assert.equal(identifyEmbedProvider('https://widgets.tiktok.com/embed.js')?.id, 'tiktok');
  assert.equal(identifyEmbedProvider('https://tiktok.com/@creator'), null);
});

test('identifyEmbedProvider correctly identifies Facebook embeds', () => {
  assert.equal(identifyEmbedProvider('https://www.facebook.com/plugins/video.php?href=xyz')?.id, 'facebook');
  assert.equal(identifyEmbedProvider('https://connect.facebook.net/en_US/sdk.js')?.id, 'facebook');
  assert.equal(identifyEmbedProvider('https://web.facebook.com/plugins/post.php')?.id, 'facebook');
  assert.equal(identifyEmbedProvider('https://facebook.com/login'), null);
});

test('identifyEmbedProvider correctly identifies Twitter / X widgets and embeds', () => {
  assert.equal(identifyEmbedProvider('https://platform.twitter.com/widgets.js')?.id, 'twitter');
  assert.equal(identifyEmbedProvider('https://twitter.com/widgets/tweet_button.html')?.id, 'twitter');
  assert.equal(identifyEmbedProvider('https://x.com/widgets/tweet_button.html')?.id, 'twitter');
  assert.equal(identifyEmbedProvider('https://twitter.com/home'), null);
});

test('identifyEmbedProvider correctly identifies Vimeo, Spotify, Twitch, SoundCloud', () => {
  assert.equal(identifyEmbedProvider('https://player.vimeo.com/video/76979871')?.id, 'vimeo');
  assert.equal(identifyEmbedProvider('https://open.spotify.com/embed/track/2TpxZ7JUBn3uw46aR7qd6V')?.id, 'spotify');
  assert.equal(identifyEmbedProvider('https://player.twitch.tv/?channel=shroud')?.id, 'twitch');
  assert.equal(identifyEmbedProvider('https://w.soundcloud.com/player/?url=https%3A//api.soundcloud.com/tracks/293')?.id, 'soundcloud');
});

test('isEmbedUrl helper verifies whether url is an embed', () => {
  assert.equal(isEmbedUrl('https://youtube.com/embed/abc'), true);
  assert.equal(isEmbedUrl('https://player.vimeo.com/video/123'), true);
  assert.equal(isEmbedUrl('https://google.com/search?q=hello'), false);
});

test('buildDnrRules produces Social Embed Guard block rules when enabled', async () => {
  const rules = await buildDnrRules({
    enabled: false,
    exceptions: [],
    socialEmbedsEnabled: true,
    socialEmbedExceptions: ['trusted-site.com'],
    socialEmbedProviders: { ...DEFAULT_PROVIDERS }
  });

  // Verify no tracking redirect rules since enabled is false
  assert.equal(rules.some((r) => r.id === DNR_RULE_REDIRECT_TRACKING), false);

  // Verify embed block rules are present
  const blockRules = rules.filter((r) => r.action.type === 'block');
  assert.ok(blockRules.length >= SUPPORTED_EMBED_PROVIDERS.length);

  // Each block rule must target sub_frame, script, xmlhttprequest
  for (const rule of blockRules) {
    assert.deepEqual(rule.condition.resourceTypes, ['sub_frame', 'script', 'xmlhttprequest']);
    assert.deepEqual(rule.condition.excludedInitiatorDomains, ['trusted-site.com']);
  }

  assert.equal(rules.some((r) => r.action.type === 'allow'), false);
});

test('buildDnrRules respects disabled providers', async () => {
  const customProviders = {
    ...DEFAULT_PROVIDERS,
    youtube: false,
    tiktok: false
  };

  const rules = await buildDnrRules({
    enabled: false,
    exceptions: [],
    socialEmbedsEnabled: true,
    socialEmbedProviders: customProviders
  });

  // Ensure no rule targets youtube or tiktok filters
  const youtubeRules = rules.filter((r) => r.condition.urlFilter?.includes('youtube'));
  const tiktokRules = rules.filter((r) => r.condition.urlFilter?.includes('tiktok'));
  assert.equal(youtubeRules.length, 0);
  assert.equal(tiktokRules.length, 0);

  // Other providers (e.g. vimeo, spotify) must still be present
  const vimeoRules = rules.filter((r) => r.condition.urlFilter?.includes('vimeo'));
  assert.ok(vimeoRules.length > 0);
});

test('buildDnrRules combines tracking cleaner and embed guard rules simultaneously', async () => {
  const rules = await buildDnrRules({
    enabled: true,
    exceptions: ['cleaner-exempt.org'],
    socialEmbedsEnabled: true,
    socialEmbedExceptions: ['embed-exempt.org']
  });

  assert.ok(rules.some((r) => r.id === DNR_RULE_REDIRECT_TRACKING));
  assert.ok(rules.some((r) => r.action.type === 'block' && r.condition.excludedInitiatorDomains?.includes('embed-exempt.org')));
});
