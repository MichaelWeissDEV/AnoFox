import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBundle, validateIndex, STATIC_RULE_LIMIT } from '../src/protection/adblock/bundle.ts';

const input = (text: string, id = 'easylist') => ({
  id, name: id, sourceUrl: 'https://example.invalid/x.txt', license: 'GPL-3.0-or-later', attribution: 'x', text, sha256: '0', fetchedAt: '2026-01-01T00:00:00Z'
});

test('bundle: compiles network rules, strips cosmetic filters into their own entries', () => {
  const b = buildBundle([input('||a.example/ad.js\n@@||a.example/ok.js\n##.ad\nb.example##.x\n')], '2026-01-01T00:00:00Z');
  assert.equal(b.index.lists[0].rulesetId, 'bundled-easylist');
  assert.ok(b.rulesets['bundled-easylist'].length >= 2);
  assert.equal(b.cosmetic.easylist.length, 2);
  assert.equal(b.index.totalRules, b.rulesets['bundled-easylist'].length);
});

test('bundle: rule ids are unique and start at 1', () => {
  const b = buildBundle([input('||a.example/1\n||b.example/2\n||c.example/3\n')]);
  const ids = b.rulesets['bundled-easylist'].map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(Math.min(...ids), 1);
});

test('bundle: refuses a snapshot that does not fit instead of truncating', () => {
  const lines = Array.from({ length: STATIC_RULE_LIMIT + 50 }, (_, i) => `||h${i}.example/p${i}.js`).join('\n');
  assert.throws(() => buildBundle([input(lines)]));
});

test('validateIndex: accepts built index, rejects tampered ones', () => {
  const b = buildBundle([input('||a.example/ad.js\n')]);
  assert.ok(validateIndex(JSON.parse(JSON.stringify(b.index))));
  assert.equal(validateIndex(null), null);
  assert.equal(validateIndex({ ...b.index, schema: 2 }), null);
  assert.equal(validateIndex({ ...b.index, lists: [{ ...b.index.lists[0], rulesetId: 'evil' }] }), null);
  assert.equal(validateIndex({ ...b.index, lists: [{ ...b.index.lists[0], id: '../x', rulesetId: 'bundled-../x' }] }), null);
});
