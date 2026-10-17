/**
 * Design tokens: the single source of truth for every colour the UI ships (options page, popup, warning page).
 * build.mjs injects them into ui.css, and test/ui-tokens.test.ts verifies the WCAG 2.2 contrast of every pair that is
 * used for text or component boundaries in BOTH themes, so a token change that breaks accessibility fails the build.
 * Plain .mjs on purpose: it is imported by the build script and by tests without a TypeScript step.
 */
export const THEMES = {
  dark: {
    'bg-primary': '#0e171d', 'bg-secondary': '#142229', 'bg-card': '#1a2c35', 'bg-card-hover': '#1f3540', 'bg-input': '#101c22',
    accent: '#6ad7b0', 'accent-hover': '#83e3c0', 'accent-text': '#0b1a20',
    'text-primary': '#edf6f5', 'text-muted': '#a9c0be',
    danger: '#ff8f8f', 'danger-hover': '#ffb0b0', warning: '#f5c26b', success: '#6ad7b0',
    border: '#284452', 'border-subtle': '#1c303a', 'border-strong': '#6f93a3', focus: '#6ad7b0',
    shadow: '0 4px 18px rgba(0, 0, 0, 0.35)'
  },
  light: {
    'bg-primary': '#f5f8fa', 'bg-secondary': '#ffffff', 'bg-card': '#ffffff', 'bg-card-hover': '#eef3f6', 'bg-input': '#f1f5f9',
    accent: '#0b6b63', 'accent-hover': '#085a53', 'accent-text': '#ffffff',
    'text-primary': '#0f172a', 'text-muted': '#4b5a69',
    danger: '#b42318', 'danger-hover': '#8f1d14', warning: '#8a4b00', success: '#0b6b63',
    border: '#e2e8f0', 'border-subtle': '#cbd5e1', 'border-strong': '#697b8c', focus: '#0b6b63',
    shadow: '0 4px 18px rgba(0, 0, 0, 0.08)'
  }
};

/** [foreground, background, minimum ratio]: 4.5 for text, 3 for component boundaries and focus indicators (WCAG 2.2 AA). */
export const CONTRAST_REQUIREMENTS = [
  ['text-primary', 'bg-primary', 4.5], ['text-primary', 'bg-secondary', 4.5], ['text-primary', 'bg-card', 4.5], ['text-primary', 'bg-input', 4.5], ['text-primary', 'bg-card-hover', 4.5],
  ['text-muted', 'bg-primary', 4.5], ['text-muted', 'bg-secondary', 4.5], ['text-muted', 'bg-card', 4.5], ['text-muted', 'bg-input', 4.5], ['text-muted', 'bg-card-hover', 4.5],
  ['accent', 'bg-primary', 4.5], ['accent', 'bg-card', 4.5], ['accent', 'bg-secondary', 4.5], ['accent-text', 'accent', 4.5], ['accent-text', 'accent-hover', 4.5],
  ['danger', 'bg-card', 4.5], ['danger', 'bg-primary', 4.5], ['danger-hover', 'bg-card', 4.5], ['warning', 'bg-card', 4.5], ['success', 'bg-card', 4.5],
  ['border-strong', 'bg-input', 3], ['border-strong', 'bg-card', 3], ['border-strong', 'bg-primary', 3], ['focus', 'bg-primary', 3], ['focus', 'bg-card', 3], ['focus', 'bg-secondary', 3]
];

function channel(c) { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }
export function luminance(hex) {
  const h = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}
export function contrast(a, b) {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const vars = (t) => Object.entries(t).map(([k, v]) => `  --${k}: ${v};`).join('\n');

/** CSS custom properties for both themes (explicit data-theme wins, otherwise the OS preference). */
export function tokensCss() {
  return `:root, :root[data-theme="dark"] {\n${vars(THEMES.dark)}\n  color-scheme: dark;\n}\n` +
    `:root[data-theme="light"] {\n${vars(THEMES.light)}\n  color-scheme: light;\n}\n` +
    `@media (prefers-color-scheme: light) {\n  :root:not([data-theme]) {\n${vars(THEMES.light).replace(/^/gm, '  ')}\n    color-scheme: light;\n  }\n}\n`;
}
