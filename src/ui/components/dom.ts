/**
 * Tiny DOM component helpers for the dashboard. Text is always set through textContent (no innerHTML anywhere),
 * every control created here gets an accessible name, and focus survives re-rendering.
 */

type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K, props: { class?: string; text?: string; attrs?: Record<string, string> } = {}, ...children: Child[]
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (props.class) e.className = props.class;
  if (props.text !== undefined) e.textContent = props.text;
  for (const [k, v] of Object.entries(props.attrs ?? {})) e.setAttribute(k, v);
  for (const c of children) if (c) e.append(c);
  return e;
}

export type ChipKind = 'neutral' | 'ok' | 'warn' | 'danger';
export function chip(text: string, kind: ChipKind = 'neutral'): HTMLSpanElement {
  return h('span', { class: `ui-chip${kind === 'neutral' ? '' : ` ui-chip--${kind}`}`, text });
}

export function notice(kind: 'info' | 'warn', title: string, text: string): HTMLElement {
  const box = h('div', { class: `ui-notice ui-notice--${kind}`, attrs: { role: kind === 'warn' ? 'alert' : 'note' } });
  const body = h('div');
  body.append(h('strong', { text: title }), h('span', { text }));
  box.append(body);
  return box;
}

export function button(label: string, onClick: () => void | Promise<void>, opts: { primary?: boolean; title?: string } = {}): HTMLButtonElement {
  const b = h('button', { class: `ui-btn${opts.primary ? ' ui-btn--primary' : ''}`, text: label, attrs: { type: 'button' } });
  if (opts.title) b.title = opts.title;
  b.addEventListener('click', () => void onClick());
  return b;
}

/** Stable identity of a control across re-renders: tag + accessible name (+ nth among equals). */
function focusKey(el: Element | null, root: HTMLElement): string | null {
  if (!el || !root.contains(el) || el === root) return null;
  const name = el.getAttribute('aria-label') ?? (el as HTMLElement).innerText ?? el.textContent ?? '';
  const key = `${el.tagName}|${name.trim().slice(0, 80)}`;
  const same = Array.from(root.querySelectorAll(el.tagName)).filter((x) => `${x.tagName}|${(x.getAttribute('aria-label') ?? (x as HTMLElement).innerText ?? '').trim().slice(0, 80)}` === key);
  return `${key}|${same.indexOf(el)}`;
}

/** Runs a re-render and puts keyboard focus back on the equivalent control (or, if gone, on the container). */
export async function keepFocus<T>(root: HTMLElement, render: () => Promise<T>): Promise<T> {
  const wanted = focusKey(document.activeElement, root);
  const result = await render();
  if (wanted) {
    const [tag, name, nth] = [wanted.split('|')[0], wanted.split('|').slice(1, -1).join('|'), Number(wanted.split('|').at(-1))];
    const candidates = Array.from(root.querySelectorAll<HTMLElement>(tag)).filter((x) => `${(x.getAttribute('aria-label') ?? x.innerText ?? '').trim().slice(0, 80)}` === name);
    (candidates[nth] ?? candidates[0])?.focus();
  }
  return result;
}
