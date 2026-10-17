/**
 * AnoFox Content Script - Social Embed Guard
 * Runs at document_start to intercept third-party embed elements and iframes,
 * neutralizes early network connections, and displays a privacy-first
 * interactive click-to-load placeholder with Light & Dark mode support.
 */

import {
  SUPPORTED_EMBED_PROVIDERS,
  identifyEmbedProvider,
  EMBED_ICONS,
  DEFAULT_PROVIDERS
} from './embed-guard.ts';
import type {
  EmbedProviderDefinition,
  SocialEmbedProviders
} from './embed-guard.ts';
import { sanitizeDomainList } from './dnr-manager.ts';

interface StoredGuardSettings {
  socialEmbedsEnabled?: boolean;
  socialEmbedExceptions?: string[];
  socialEmbedProviders?: SocialEmbedProviders;
  theme?: 'system' | 'dark' | 'light';
}

let activeSettings: Required<StoredGuardSettings> = {
  socialEmbedsEnabled: true,
  socialEmbedExceptions: [],
  socialEmbedProviders: { ...DEFAULT_PROVIDERS },
  theme: 'dark'
};

const processedElements = new WeakSet<Element>();
const activePlaceholders: Array<{
  container: HTMLElement;
  restore: () => void;
}> = [];

function isSiteExcluded(): boolean {
  const currentHost = window.location.hostname.toLowerCase();
  for (const domain of activeSettings.socialEmbedExceptions) {
    if (currentHost === domain || currentHost.endsWith('.' + domain)) {
      return true;
    }
  }
  return false;
}

function getResolvedTheme(): 'dark' | 'light' {
  if (activeSettings.theme === 'light') return 'light';
  if (activeSettings.theme === 'dark') return 'dark';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/**
 * Creates the Shadow DOM placeholder element for a blocked embed using safe DOM manipulation.
 */
function createPlaceholderCard(
  provider: EmbedProviderDefinition,
  targetUrl: string,
  originalElement: HTMLElement,
  onUnlock: () => void
): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'anofox-embed-placeholder-root';
  wrapper.setAttribute('data-anofox-provider', provider.id);

  const origWidth = originalElement.getAttribute('width') || originalElement.style.width;
  const origHeight = originalElement.getAttribute('height') || originalElement.style.height;

  wrapper.style.display = 'block';
  wrapper.style.width = origWidth ? (origWidth.includes('%') || origWidth.includes('px') ? origWidth : `${origWidth}px`) : '100%';
  wrapper.style.maxWidth = '100%';
  wrapper.style.margin = '12px auto';

  const shadow = wrapper.attachShadow({ mode: 'open' });
  const theme = getResolvedTheme();

  const styleEl = document.createElement('style');
  styleEl.textContent = `
    :host {
      --af-bg: ${theme === 'dark' ? '#182830' : '#ffffff'};
      --af-card-bg: ${theme === 'dark' ? '#142229' : '#f8fafc'};
      --af-border: ${theme === 'dark' ? '#294653' : '#e2e8f0'};
      --af-text: ${theme === 'dark' ? '#edf6f5' : '#0f172a'};
      --af-muted: ${theme === 'dark' ? '#95b3b1' : '#64748b'};
      --af-accent: ${theme === 'dark' ? '#6ad7b0' : '#0d9488'};
      --af-accent-hover: ${theme === 'dark' ? '#83e3c0' : '#0f766e'};
      --af-accent-text: ${theme === 'dark' ? '#0b1a20' : '#ffffff'};
      --af-brand: ${provider.brandColor};
      display: block;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      box-sizing: border-box;
    }

    * { box-sizing: border-box; }

    .card {
      background: var(--af-card-bg);
      border: 1px solid var(--af-border);
      border-radius: 10px;
      padding: 16px;
      min-height: ${origHeight && !origHeight.includes('%') ? `${Math.min(parseInt(origHeight, 10), 380)}px` : '200px'};
      display: flex;
      flex-direction: column;
      justify-content: center;
      align-items: center;
      text-align: center;
      color: var(--af-text);
      box-shadow: 0 4px 14px rgba(0, 0, 0, 0.08);
      position: relative;
      overflow: hidden;
    }

    .brand-stripe {
      position: absolute;
      top: 0; left: 0; right: 0;
      height: 3px;
      background: var(--af-brand);
    }

    .badge-row {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-bottom: 12px;
    }

    .guard-badge {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.3px;
      text-transform: uppercase;
      background: ${theme === 'dark' ? '#1d323c' : '#e6fffa'};
      color: var(--af-accent);
      border: 1px solid var(--af-border);
      padding: 3px 8px;
      border-radius: 12px;
    }

    .guard-badge svg {
      width: 13px;
      height: 13px;
    }

    .provider-info {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 8px;
    }

    .provider-icon {
      width: 24px;
      height: 24px;
      color: var(--af-brand);
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .provider-icon svg {
      width: 100%;
      height: 100%;
    }

    h3 {
      margin: 0;
      font-size: 15px;
      font-weight: 700;
      letter-spacing: -0.2px;
    }

    p.desc {
      margin: 6px 0 14px;
      font-size: 12px;
      line-height: 1.45;
      color: var(--af-muted);
      max-width: 440px;
    }

    .url-link {
      color: var(--af-muted);
      font-size: 11px;
      text-decoration: underline;
      margin-bottom: 14px;
      word-break: break-all;
      max-width: 420px;
      opacity: 0.85;
    }

    .url-link:hover {
      color: var(--af-accent);
    }

    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      justify-content: center;
      align-items: center;
    }

    button {
      font-family: inherit;
      font-size: 12px;
      font-weight: 600;
      padding: 8px 16px;
      border-radius: 6px;
      cursor: pointer;
      transition: all .15s ease;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      border: 1px solid transparent;
    }

    .btn-primary {
      background: var(--af-accent);
      color: var(--af-accent-text);
    }

    .btn-primary:hover {
      background: var(--af-accent-hover);
      transform: translateY(-1px);
    }

    .btn-secondary {
      background: ${theme === 'dark' ? '#1f343f' : '#f1f5f9'};
      color: var(--af-text);
      border-color: var(--af-border);
    }

    .btn-secondary:hover {
      background: ${theme === 'dark' ? '#27414f' : '#e2e8f0'};
    }

    .footer-note {
      margin-top: 10px;
      font-size: 10px;
      color: var(--af-muted);
    }
  `;
  shadow.appendChild(styleEl);

  const card = document.createElement('div');
  card.className = 'card';

  const stripe = document.createElement('div');
  stripe.className = 'brand-stripe';
  card.appendChild(stripe);

  const badgeRow = document.createElement('div');
  badgeRow.className = 'badge-row';
  const badge = document.createElement('span');
  badge.className = 'guard-badge';
  const parser = new DOMParser();
  const shieldDoc = parser.parseFromString(EMBED_ICONS.shield, 'image/svg+xml');
  if (shieldDoc.documentElement) badge.appendChild(shieldDoc.documentElement);
  badge.appendChild(document.createTextNode(' Social Embed Guard'));
  badgeRow.appendChild(badge);
  card.appendChild(badgeRow);

  const providerInfo = document.createElement('div');
  providerInfo.className = 'provider-info';
  const providerIcon = document.createElement('div');
  providerIcon.className = 'provider-icon';
  const iconDoc = parser.parseFromString(provider.iconSvg, 'image/svg+xml');
  if (iconDoc.documentElement) providerIcon.appendChild(iconDoc.documentElement);

  const heading = document.createElement('h3');
  heading.textContent = `${provider.name}-Inhalt blockiert`;
  providerInfo.appendChild(providerIcon);
  providerInfo.appendChild(heading);
  card.appendChild(providerInfo);

  const desc = document.createElement('p');
  desc.className = 'desc';
  desc.textContent = `Dieser Inhalt wurde zum Schutz Ihrer Daten blockiert, bevor eine Verbindung zu ${provider.name} hergestellt wurde.`;
  card.appendChild(desc);

  if (targetUrl) {
    const link = document.createElement('a');
    link.className = 'url-link';
    link.href = targetUrl;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = `Inhalt direkt bei ${provider.name} öffnen ↗`;
    card.appendChild(link);
  }

  const actions = document.createElement('div');
  actions.className = 'actions';

  const btnLoad = document.createElement('button');
  btnLoad.type = 'button';
  btnLoad.className = 'btn-primary';
  btnLoad.textContent = '▶ Inhalt laden';

  const btnWhitelist = document.createElement('button');
  btnWhitelist.type = 'button';
  btnWhitelist.className = 'btn-secondary';
  btnWhitelist.textContent = '✓ Immer auf dieser Website erlauben';

  actions.appendChild(btnLoad);
  actions.appendChild(btnWhitelist);
  card.appendChild(actions);

  const footer = document.createElement('div');
  footer.className = 'footer-note';
  footer.textContent = 'Lokaler Schutz durch AnoFox • Erst nach Klick werden Daten übertragen';
  card.appendChild(footer);

  shadow.appendChild(card);

  btnLoad.addEventListener('click', async () => {
    btnLoad.disabled = true;
    btnLoad.textContent = 'Lade Inhalt...';

    try {
      if (targetUrl) {
        await browser.runtime.sendMessage({
          type: 'ALLOW_EMBED_URL',
          url: targetUrl
        });
        await browser.runtime.sendMessage({
          type: 'LOG_EMBED_EVENT',
          action: 'LOADED',
          provider: provider.name,
          site: window.location.hostname,
          url: targetUrl
        });
      }
    } catch (e) {
      console.warn('AnoFox: Konnte Freigabe nicht an Hintergrund senden:', e);
    }

    onUnlock();
  });

  btnWhitelist.addEventListener('click', async () => {
    btnWhitelist.disabled = true;
    btnWhitelist.textContent = 'Gespeichert...';

    try {
      await browser.runtime.sendMessage({
        type: 'ADD_EMBED_EXCEPTION',
        domain: window.location.hostname
      });
      unlockAllPlaceholders();
    } catch (e) {
      console.error('AnoFox: Fehler beim Hinzufügen der Ausnahme:', e);
      onUnlock();
    }
  });

  return wrapper;
}

/**
 * Intercepts an element (iframe or social widget) and replaces it with a placeholder.
 */
function interceptElement(element: HTMLElement, provider: EmbedProviderDefinition): void {
  if (processedElements.has(element)) return;
  processedElements.add(element);

  const targetUrl = provider.extractUrl(element) || '';
  const isIframe = element.tagName.toLowerCase() === 'iframe';

  // Neutralize iframe immediately to prevent or abort network connections
  if (isIframe) {
    const iframe = element as HTMLIFrameElement;
    iframe.removeAttribute('src');
    iframe.src = 'about:blank';
  }

  // Notify background about block event
  void browser.runtime.sendMessage({
    type: 'LOG_EMBED_EVENT',
    action: 'BLOCKED',
    provider: provider.name,
    providerId: provider.id,
    site: window.location.hostname,
    url: targetUrl
  });

  const restoreAction = (): void => {
    if (isIframe && targetUrl) {
      const freshIframe = document.createElement('iframe');
      for (let i = 0; i < element.attributes.length; i++) {
        const attr = element.attributes[i];
        if (attr.name !== 'src') {
          freshIframe.setAttribute(attr.name, attr.value);
        }
      }
      freshIframe.src = targetUrl;
      placeholderCard.replaceWith(freshIframe);
      processedElements.add(freshIframe);
    } else {
      placeholderCard.replaceWith(element);
    }
  };

  const placeholderCard = createPlaceholderCard(provider, targetUrl, element, restoreAction);

  activePlaceholders.push({
    container: placeholderCard,
    restore: restoreAction
  });

  if (element.parentNode) {
    element.parentNode.replaceChild(placeholderCard, element);
  }
}

function unlockAllPlaceholders(): void {
  const list = [...activePlaceholders];
  activePlaceholders.length = 0;
  for (const item of list) {
    try {
      item.restore();
    } catch {
      // Ignored if already removed
    }
  }
}

/**
 * Scans a subtree for matching embed elements.
 */
function scanSubtree(root: ParentNode): void {
  if (!activeSettings.socialEmbedsEnabled || isSiteExcluded()) {
    return;
  }

  for (const provider of SUPPORTED_EMBED_PROVIDERS) {
    const isProviderActive = activeSettings.socialEmbedProviders[provider.id] ?? true;
    if (!isProviderActive) continue;

    try {
      const matchingElements = root.querySelectorAll<HTMLElement>(provider.domSelector);
      for (let i = 0; i < matchingElements.length; i++) {
        const el = matchingElements[i];
        if (!processedElements.has(el)) {
          const url = provider.extractUrl(el);
          if (url && (provider.matchUrl(url) || el.matches(provider.domSelector))) {
            interceptElement(el, provider);
          }
        }
      }
    } catch {
      // Ignore selector errors
    }
  }
}

/**
 * Initializes the content script observer and loads settings.
 */
async function init(): Promise<void> {
  try {
    const stored = (await browser.storage.local.get([
      'socialEmbedsEnabled',
      'socialEmbedExceptions',
      'socialEmbedProviders',
      'theme'
    ])) as StoredGuardSettings;

    if (stored) {
      activeSettings = {
        socialEmbedsEnabled: typeof stored.socialEmbedsEnabled === 'boolean' ? stored.socialEmbedsEnabled : true,
        socialEmbedExceptions: Array.isArray(stored.socialEmbedExceptions) ? sanitizeDomainList(stored.socialEmbedExceptions) : [],
        socialEmbedProviders: stored.socialEmbedProviders ? { ...DEFAULT_PROVIDERS, ...stored.socialEmbedProviders } : { ...DEFAULT_PROVIDERS },
        theme: ['system', 'dark', 'light'].includes(stored.theme || '') ? (stored.theme as 'system' | 'dark' | 'light') : 'dark'
      };
    }
  } catch {
    // Keep defaults
  }

  if (!activeSettings.socialEmbedsEnabled || isSiteExcluded()) {
    return;
  }

  // Scan existing document
  if (document.body) {
    scanSubtree(document.body);
  } else {
    scanSubtree(document);
  }

  // Observe DOM additions as the page streams in
  const observer = new MutationObserver((mutations) => {
    if (!activeSettings.socialEmbedsEnabled || isSiteExcluded()) {
      return;
    }

    for (const mutation of mutations) {
      for (let i = 0; i < mutation.addedNodes.length; i++) {
        const node = mutation.addedNodes[i];
        if (node.nodeType === Node.ELEMENT_NODE) {
          const el = node as HTMLElement;
          // Check element itself
          for (const provider of SUPPORTED_EMBED_PROVIDERS) {
            const isProviderActive = activeSettings.socialEmbedProviders[provider.id] ?? true;
            if (!isProviderActive) continue;

            if (el.matches && el.matches(provider.domSelector)) {
              interceptElement(el, provider);
              break;
            }
          }
          // Check descendants
          scanSubtree(el);
        }
      }
    }
  });

  observer.observe(document.documentElement || document, {
    childList: true,
    subtree: true
  });

  // Re-scan on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      scanSubtree(document);
    }, { once: true });
  }

  // Listen for settings changes
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;

    if (changes.socialEmbedsEnabled) {
      activeSettings.socialEmbedsEnabled = Boolean(changes.socialEmbedsEnabled.newValue);
      if (!activeSettings.socialEmbedsEnabled) {
        unlockAllPlaceholders();
      }
    }

    if (changes.socialEmbedExceptions) {
      activeSettings.socialEmbedExceptions = Array.isArray(changes.socialEmbedExceptions.newValue)
        ? sanitizeDomainList(changes.socialEmbedExceptions.newValue)
        : [];
      if (isSiteExcluded()) {
        unlockAllPlaceholders();
      }
    }

    if (changes.socialEmbedProviders) {
      activeSettings.socialEmbedProviders = {
        ...DEFAULT_PROVIDERS,
        ...changes.socialEmbedProviders.newValue
      };
    }

    if (changes.theme) {
      activeSettings.theme = changes.theme.newValue;
    }
  });
}

void init();
