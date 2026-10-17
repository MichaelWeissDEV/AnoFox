import test from 'node:test';
import assert from 'node:assert/strict';
import { THEMES, CONTRAST_REQUIREMENTS, contrast, tokensCss } from '../src/ui/tokens.mjs';

test('contrast helper matches the WCAG reference values', () => {
  assert.equal(contrast('#000000', '#ffffff').toFixed(2), '21.00');
  assert.equal(contrast('#777777', '#ffffff').toFixed(2), '4.48');
  assert.equal(contrast('#ffffff', '#ffffff').toFixed(2), '1.00');
});

test('every text / boundary / focus pair meets WCAG 2.2 AA in both themes', () => {
  const failures: string[] = [];
  for (const [theme, tokens] of Object.entries(THEMES)) {
    for (const [fg, bg, need] of CONTRAST_REQUIREMENTS as Array<[string, string, number]>) {
      const ratio = contrast((tokens as Record<string, string>)[fg], (tokens as Record<string, string>)[bg]);
      if (ratio < need) failures.push(`${theme}: ${fg} on ${bg} = ${ratio.toFixed(2)} (< ${need})`);
    }
  }
  assert.deepEqual(failures, []);
});

test('both themes define exactly the same tokens and every colour is a 6-digit hex', () => {
  assert.deepEqual(Object.keys(THEMES.dark).sort(), Object.keys(THEMES.light).sort());
  for (const t of Object.values(THEMES)) for (const [k, v] of Object.entries(t)) if (k !== 'shadow') assert.match(v as string, /^#[0-9a-f]{6}$/, k);
});

test('generated CSS covers explicit themes and the OS preference', () => {
  const css = tokensCss();
  for (const needle of ['[data-theme="dark"]', '[data-theme="light"]', 'prefers-color-scheme: light', '--accent-text', '--border-strong', 'color-scheme: light']) assert.ok(css.includes(needle), needle);
});
