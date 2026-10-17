import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanUrlDetailed, cleanUrl, isTrackingParam, isSignedOrAuthUrl, isDomainExcluded, generateDnrRemoveParams } from '../src/url-cleaner.ts';

test('isTrackingParam identifies various tracking parameters', () => {
  assert.equal(isTrackingParam('utm_source'), true);
  assert.equal(isTrackingParam('UTM_CAMPAIGN'), true);
  assert.equal(isTrackingParam('Utm_Medium'), true);
  assert.equal(isTrackingParam('fbclid'), true);
  assert.equal(isTrackingParam('FBCLID'), true);
  assert.equal(isTrackingParam('gclid'), true);
  assert.equal(isTrackingParam('msclkid'), true);
  assert.equal(isTrackingParam('mc_eid'), true);
  assert.equal(isTrackingParam('srsltid'), true);
  assert.equal(isTrackingParam('pk_campaign'), true);
  assert.equal(isTrackingParam('mtm_source'), true);

  // Normal query params should not be identified as tracking
  assert.equal(isTrackingParam('q'), false);
  assert.equal(isTrackingParam('page'), false);
  assert.equal(isTrackingParam('id'), false);
  assert.equal(isTrackingParam('sort'), false);
});

test('cleanUrl handles mixed and uppercase casing correctly', () => {
  const url = 'https://example.com/item?UTM_SOURCE=twitter&GCLID=12345&keep=me';
  const result = cleanUrl(url);
  assert.equal(result, 'https://example.com/item?keep=me');
});

test('cleanUrl removes duplicate tracking parameters', () => {
  const url = 'https://example.com/search?utm_source=first&utm_source=second&fbclid=abc&fbclid=xyz&q=shoes';
  const result = cleanUrlDetailed(url);
  assert.equal(result.wasCleaned, true);
  assert.equal(result.cleanedUrl, 'https://example.com/search?q=shoes');
  assert.deepEqual(result.removedParams.sort(), ['fbclid', 'utm_source'].sort());
});

test('cleanUrl preserves URL fragments (#)', () => {
  const url = 'https://example.com/article?utm_source=feed&id=42#comments-section';
  const result = cleanUrl(url);
  assert.equal(result, 'https://example.com/article?id=42#comments-section');
});

test('cleanUrl preserves URL encoding properly', () => {
  const url = 'https://example.com/search?q=hello%20world&filter=%C3%BCber&utm_medium=email';
  const result = cleanUrl(url);
  assert.equal(result, 'https://example.com/search?q=hello%20world&filter=%C3%BCber');
});

test('cleanUrl protects AWS S3 and HMAC signed URLs', () => {
  const s3Url = 'https://my-bucket.s3.amazonaws.com/report.pdf?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20261016%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20261016T000000Z&X-Amz-Expires=86400&X-Amz-Signature=abcdef123456&utm_source=newsletter';
  const result = cleanUrlDetailed(s3Url);
  assert.equal(result.wasCleaned, false);
  assert.equal(result.reason, 'signed_or_auth_url');
  assert.equal(result.cleanedUrl, s3Url);

  const hmacUrl = 'https://cdn.example.org/download/file.zip?signature=deadbeef9876&utm_campaign=promo';
  assert.equal(cleanUrl(hmacUrl), hmacUrl);
});

test('cleanUrl protects authentication links and OAuth flows', () => {
  const oauthCallback = 'https://app.example.com/oauth/callback?code=splat-1234&state=xyz987&utm_source=login';
  const result = cleanUrlDetailed(oauthCallback);
  assert.equal(result.wasCleaned, false);
  assert.equal(result.reason, 'signed_or_auth_url');
  assert.equal(result.cleanedUrl, oauthCallback);

  const magicLink = 'https://service.example.com/auth/verify?magic_link=abc12345&utm_medium=email';
  assert.equal(cleanUrl(magicLink), magicLink);
});

test('cleanUrl respects website-specific exceptions', () => {
  const url = 'https://tracker-test.example.com/page?utm_source=newsletter&fbclid=999';
  
  // Without exceptions, it cleans
  assert.equal(cleanUrl(url), 'https://tracker-test.example.com/page');

  // With parent domain exception, it skips cleaning
  const result = cleanUrlDetailed(url, { exceptions: ['example.com'] });
  assert.equal(result.wasCleaned, false);
  assert.equal(result.reason, 'domain_exception');
  assert.equal(result.cleanedUrl, url);
});

test('isDomainExcluded matches exact domain and subdomains', () => {
  const exceptions = ['example.com', '*.whitelist.org', 'test.net'];
  assert.equal(isDomainExcluded('example.com', exceptions), true);
  assert.equal(isDomainExcluded('sub.example.com', exceptions), true);
  assert.equal(isDomainExcluded('deep.sub.example.com', exceptions), true);
  assert.equal(isDomainExcluded('whitelist.org', exceptions), true);
  assert.equal(isDomainExcluded('app.whitelist.org', exceptions), true);
  assert.equal(isDomainExcluded('other.com', exceptions), false);
  assert.equal(isDomainExcluded('notexample.com', exceptions), false);
});

test('generateDnrRemoveParams outputs lowercase, uppercase and capitalized variations', () => {
  const params = generateDnrRemoveParams();
  assert.ok(params.includes('utm_source'));
  assert.ok(params.includes('UTM_SOURCE'));
  assert.ok(params.includes('Utm_source'));
  assert.ok(params.includes('fbclid'));
  assert.ok(params.includes('FBCLID'));
  assert.ok(params.includes('Fbclid'));
});
