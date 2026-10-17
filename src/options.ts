/**
 * AnoFox Options & Management Dashboard
 * Provides full control over Social Embed Guard providers & allowlists,
 * URL tracking cleaner exceptions, logging severity, appearance, backup,
 * and ephemeral in-memory privacy statistics & internal AnoFox logging.
 */

import {
  SUPPORTED_EMBED_PROVIDERS,
  DEFAULT_PROVIDERS
} from './embed-guard.ts';
import { KNOWN_TRACKING_PARAMS } from './url-cleaner.ts';
import { sanitizeDomainList } from './core/domain-utils/domains.ts';
import { initPolicyPanel } from './ui/settings/policy-panel.ts';
import { defaultSettings, exportSettings } from './core/settings/settings.ts';
import type { LogSeverity, InternalLogEntry } from './logger.ts';
import type { AnoFoxSettings } from './background.ts';
import type { StatisticsSnapshot, BlockedItemRecord } from './stats.ts';

let currentSettings: AnoFoxSettings = defaultSettings();

let cachedStatistics: StatisticsSnapshot | null = null;
let cachedInternalLogs: InternalLogEntry[] = [];

// UI Elements
const themeBtns = document.querySelectorAll<HTMLButtonElement>('.theme-btn');
const navLinks = document.querySelectorAll<HTMLButtonElement>('.nav-link');
const tabPanes = document.querySelectorAll<HTMLElement>('.tab-pane');

const embedsMasterToggle = document.querySelector<HTMLInputElement>('#embeds-master-toggle')!;
const cleanerMasterToggle = document.querySelector<HTMLInputElement>('#cleaner-master-toggle')!;
const terminalMasterToggle = document.querySelector<HTMLInputElement>('#terminal-master-toggle')!;
const severitySelect = document.querySelector<HTMLSelectElement>('#options-log-severity')!;

const providersContainer = document.querySelector<HTMLElement>('#providers-container')!;

const embedDomainInput = document.querySelector<HTMLInputElement>('#embed-domain-input')!;
const embedDomainAddBtn = document.querySelector<HTMLButtonElement>('#embed-domain-add-btn')!;
const embedDomainSearch = document.querySelector<HTMLInputElement>('#embed-domain-search')!;
const embedClearAllBtn = document.querySelector<HTMLButtonElement>('#embed-clear-all-btn')!;
const embedDomainListEl = document.querySelector<HTMLElement>('#embed-domain-list')!;

const cleanerDomainInput = document.querySelector<HTMLInputElement>('#cleaner-domain-input')!;
const cleanerDomainAddBtn = document.querySelector<HTMLButtonElement>('#cleaner-domain-add-btn')!;
const cleanerDomainSearch = document.querySelector<HTMLInputElement>('#cleaner-domain-search')!;
const cleanerClearAllBtn = document.querySelector<HTMLButtonElement>('#cleaner-clear-all-btn')!;
const cleanerDomainListEl = document.querySelector<HTMLElement>('#cleaner-domain-list')!;

const paramListEl = document.querySelector<HTMLElement>('#param-list')!;

// Stats & Insights UI Elements
const statsMasterToggle = document.querySelector<HTMLInputElement>('#stats-master-toggle')!;
const statsDisabledContainer = document.querySelector<HTMLElement>('#stats-disabled-container')!;
const statsEnabledContainer = document.querySelector<HTMLElement>('#stats-enabled-container')!;
const statTotalBlocked = document.querySelector<HTMLElement>('#stat-total-blocked')!;
const statCleanedUrls = document.querySelector<HTMLElement>('#stat-cleaned-urls')!;
const statCleanedParamsDesc = document.querySelector<HTMLElement>('#stat-cleaned-params-desc')!;
const statBlockedEmbeds = document.querySelector<HTMLElement>('#stat-blocked-embeds')!;
const statsProvidersList = document.querySelector<HTMLElement>('#stats-providers-list')!;
const statsParamsList = document.querySelector<HTMLElement>('#stats-params-list')!;
const insightsSearchInput = document.querySelector<HTMLInputElement>('#insights-search-input')!;
const insightsTableBody = document.querySelector<HTMLElement>('#insights-table-body')!;
const internalLogLevelFilter = document.querySelector<HTMLSelectElement>('#internal-log-level-filter')!;
const internalLogConsole = document.querySelector<HTMLElement>('#internal-log-console')!;
const btnRefreshStats = document.querySelector<HTMLButtonElement>('#btn-refresh-stats')!;
const btnClearStats = document.querySelector<HTMLButtonElement>('#btn-clear-stats')!;

const btnExport = document.querySelector<HTMLButtonElement>('#btn-export-settings')!;
const btnImportTrigger = document.querySelector<HTMLButtonElement>('#btn-import-trigger')!;
const importFileInput = document.querySelector<HTMLInputElement>('#import-file-input')!;
const btnReset = document.querySelector<HTMLButtonElement>('#btn-reset-factory')!;

const toastEl = document.querySelector<HTMLElement>('#toast')!;
let toastTimeout: ReturnType<typeof setTimeout> | null = null;

function showToast(message: string): void {
  if (toastTimeout) clearTimeout(toastTimeout);
  // the element stays in the DOM (aria-live="polite"), so screen readers announce the changed text
  toastEl.textContent = message;
  toastEl.classList.add('show');
  toastTimeout = setTimeout(() => {
    toastEl.classList.remove('show');
  }, 3500);
}

// Apply Theme
function applyTheme(theme: 'system' | 'dark' | 'light'): void {
  const root = document.documentElement;
  if (theme === 'system') {
    const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    root.setAttribute('data-theme', isDark ? 'dark' : 'light');
  } else {
    root.setAttribute('data-theme', theme);
  }

  themeBtns.forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.theme === theme);
    btn.setAttribute('aria-pressed', String(btn.dataset.theme === theme));
  });
}

window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
  if (currentSettings.theme === 'system') {
    document.documentElement.setAttribute('data-theme', e.matches ? 'dark' : 'light');
  }
});

// Navigation: sidebar buttons with aria-current, panes hidden via the `hidden` attribute, deep links via #hash
const mainEl = document.querySelector<HTMLElement>('#main')!;
const POLICY_TABS = new Set(['tab-overview', 'tab-policy', 'tab-rules', 'tab-lists', 'tab-threat', 'tab-consent', 'tab-storage', 'tab-fingerprint']);
navLinks.forEach((btn) => {
  const pane = document.getElementById(btn.dataset.tab ?? '');
  if (pane) { pane.setAttribute('role', 'region'); pane.setAttribute('aria-label', btn.textContent?.trim() ?? ''); }
});

function showTab(requested: string, opts: { focus?: boolean; updateHash?: boolean } = {}): void {
  const id = document.getElementById(requested)?.classList.contains('tab-pane') ? requested : 'tab-overview';
  let label = '';
  navLinks.forEach((b) => {
    const on = b.dataset.tab === id;
    if (on) { b.setAttribute('aria-current', 'page'); label = b.textContent?.trim() ?? ''; } else b.removeAttribute('aria-current');
  });
  tabPanes.forEach((pane) => { const on = pane.id === id; pane.classList.toggle('active', on); pane.hidden = !on; });
  document.title = `AnoFox – ${label}`;
  if (opts.updateHash !== false && location.hash !== `#${id}`) history.pushState(null, '', `#${id}`);
  if (opts.focus) mainEl.focus({ preventScroll: false });
  if (POLICY_TABS.has(id)) void policyPanel.render();
  if (id === 'tab-stats') void fetchAndRenderStats();
}

navLinks.forEach((btn) => btn.addEventListener('click', () => showTab(btn.dataset.tab ?? 'tab-overview', { focus: true })));
window.addEventListener('hashchange', () => showTab(location.hash.slice(1), { updateHash: false }));

// Theme switcher
themeBtns.forEach((btn) => {
  btn.addEventListener('click', async () => {
    const newTheme = btn.dataset.theme as 'system' | 'dark' | 'light';
    currentSettings.theme = newTheme;
    applyTheme(newTheme);
    await saveSettings({ theme: newTheme });
    showToast(`Design geändert: ${btn.textContent?.trim()}`);
  });
});

async function saveSettings(updates: Partial<AnoFoxSettings>): Promise<void> {
  try {
    const res = await browser.runtime.sendMessage({
      type: 'UPDATE_SETTINGS',
      settings: updates
    });
    if (res?.success && res.settings) {
      currentSettings = res.settings;
    }
  } catch (err) {
    console.error('Fehler beim Speichern der Einstellungen:', err);
    showToast('Fehler beim Speichern der Einstellungen');
  }
}

// Render Providers safely with DOM methods
function renderProviders(): void {
  providersContainer.replaceChildren();

  for (const provider of SUPPORTED_EMBED_PROVIDERS) {
    const card = document.createElement('div');
    card.className = 'provider-card';

    const isEnabled = currentSettings.socialEmbedProviders[provider.id] ?? true;

    const meta = document.createElement('div');
    meta.className = 'provider-meta';

    const iconEl = document.createElement('div');
    iconEl.className = 'provider-icon';
    iconEl.style.color = provider.brandColor;
    const parser = new DOMParser();
    const doc = parser.parseFromString(provider.iconSvg, 'image/svg+xml');
    if (doc.documentElement) {
      iconEl.appendChild(doc.documentElement);
    }

    const info = document.createElement('div');
    const nameEl = document.createElement('h3');
    nameEl.className = 'provider-name';
    nameEl.textContent = provider.name;

    const descEl = document.createElement('p');
    descEl.className = 'provider-desc';
    descEl.textContent = provider.description;

    info.appendChild(nameEl);
    info.appendChild(descEl);

    meta.appendChild(iconEl);
    meta.appendChild(info);

    const switchLabel = document.createElement('label');
    switchLabel.className = 'switch';

    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.setAttribute('role', 'switch');
    toggle.setAttribute('aria-label', `${provider.name} blockieren`);
    toggle.id = `provider-${provider.id}`;
    toggle.checked = isEnabled;

    const slider = document.createElement('span');
    slider.className = 'slider';

    switchLabel.appendChild(toggle);
    switchLabel.appendChild(slider);

    card.appendChild(meta);
    card.appendChild(switchLabel);

    toggle.addEventListener('change', async () => {
      currentSettings.socialEmbedProviders[provider.id] = toggle.checked;
      await saveSettings({ socialEmbedProviders: currentSettings.socialEmbedProviders });
      showToast(`${provider.name} ${toggle.checked ? 'aktiviert' : 'deaktiviert'}`);
    });

    providersContainer.appendChild(card);
  }
}

// Render Domain Lists safely
function renderDomainList(
  container: HTMLElement,
  domains: string[],
  searchTerm: string,
  onDelete: (domain: string) => void
): void {
  container.replaceChildren();
  const filtered = domains.filter((d) => d.toLowerCase().includes(searchTerm.toLowerCase()));

  if (filtered.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = domains.length === 0 ? 'Keine Ausnahmen eingetragen' : 'Keine passenden Domains gefunden';
    container.appendChild(empty);
    return;
  }

  for (const domain of filtered) {
    const tag = document.createElement('div');
    tag.className = 'domain-tag';

    const span = document.createElement('span');
    span.textContent = domain;

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'tag-del';
    delBtn.title = `${domain} entfernen`;
    delBtn.textContent = '×';
    delBtn.addEventListener('click', () => onDelete(domain));

    tag.appendChild(span);
    tag.appendChild(delBtn);
    container.appendChild(tag);
  }
}

function updateEmbedDomainsUI(): void {
  const search = embedDomainSearch.value.trim();
  renderDomainList(
    embedDomainListEl,
    currentSettings.socialEmbedExceptions,
    search,
    async (domainToDelete) => {
      currentSettings.socialEmbedExceptions = currentSettings.socialEmbedExceptions.filter(
        (d) => d !== domainToDelete
      );
      await saveSettings({ socialEmbedExceptions: currentSettings.socialEmbedExceptions });
      updateEmbedDomainsUI();
      showToast(`Ausnahme für ${domainToDelete} entfernt`);
    }
  );
}

function updateCleanerDomainsUI(): void {
  const search = cleanerDomainSearch.value.trim();
  renderDomainList(
    cleanerDomainListEl,
    currentSettings.exceptions,
    search,
    async (domainToDelete) => {
      currentSettings.exceptions = currentSettings.exceptions.filter(
        (d) => d !== domainToDelete
      );
      await saveSettings({ exceptions: currentSettings.exceptions });
      updateCleanerDomainsUI();
      showToast(`Ausnahme für ${domainToDelete} entfernt`);
    }
  );
}

// Add Domain Helpers
async function addEmbedDomain(): Promise<void> {
  const raw = embedDomainInput.value.trim();
  const sanitized = sanitizeDomainList([raw])[0];
  if (!sanitized) {
    showToast('Bitte gültigen Domainnamen eingeben (z. B. example.com)');
    return;
  }
  if (currentSettings.socialEmbedExceptions.includes(sanitized)) {
    showToast('Domain bereits in der Liste vorhanden');
    return;
  }
  currentSettings.socialEmbedExceptions.push(sanitized);
  await saveSettings({ socialEmbedExceptions: currentSettings.socialEmbedExceptions });
  embedDomainInput.value = '';
  updateEmbedDomainsUI();
  showToast(`Ausnahme für ${sanitized} hinzugefügt`);
}

async function addCleanerDomain(): Promise<void> {
  const raw = cleanerDomainInput.value.trim();
  const sanitized = sanitizeDomainList([raw])[0];
  if (!sanitized) {
    showToast('Bitte gültigen Domainnamen eingeben (z. B. example.com)');
    return;
  }
  if (currentSettings.exceptions.includes(sanitized)) {
    showToast('Domain bereits in der Liste vorhanden');
    return;
  }
  currentSettings.exceptions.push(sanitized);
  await saveSettings({ exceptions: currentSettings.exceptions });
  cleanerDomainInput.value = '';
  updateCleanerDomainsUI();
  showToast(`Ausnahme für ${sanitized} hinzugefügt`);
}

// Event Listeners for Lists
embedDomainAddBtn.addEventListener('click', () => void addEmbedDomain());
embedDomainInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') void addEmbedDomain();
});
embedDomainSearch.addEventListener('input', updateEmbedDomainsUI);

embedClearAllBtn.addEventListener('click', async () => {
  if (currentSettings.socialEmbedExceptions.length === 0) return;
  if (!confirm('Möchten Sie wirklich alle Embed-Ausnahmen entfernen?')) return;
  currentSettings.socialEmbedExceptions = [];
  await saveSettings({ socialEmbedExceptions: [] });
  updateEmbedDomainsUI();
  showToast('Alle Embed-Ausnahmen entfernt');
});

cleanerDomainAddBtn.addEventListener('click', () => void addCleanerDomain());
cleanerDomainInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') void addCleanerDomain();
});
cleanerDomainSearch.addEventListener('input', updateCleanerDomainsUI);

cleanerClearAllBtn.addEventListener('click', async () => {
  if (currentSettings.exceptions.length === 0) return;
  if (!confirm('Möchten Sie wirklich alle Tracking-Cleaner-Ausnahmen entfernen?')) return;
  currentSettings.exceptions = [];
  await saveSettings({ exceptions: [] });
  updateCleanerDomainsUI();
  showToast('Alle Tracking-Ausnahmen entfernt');
});

// Master Switches
embedsMasterToggle.addEventListener('change', async () => {
  const socialEmbedsEnabled = embedsMasterToggle.checked;
  await saveSettings({ socialEmbedsEnabled });
  showToast(`Social Embed Guard ${socialEmbedsEnabled ? 'aktiviert' : 'deaktiviert'}`);
});

cleanerMasterToggle.addEventListener('change', async () => {
  const enabled = cleanerMasterToggle.checked;
  await saveSettings({ enabled });
  showToast(`Tracking-Bereinigung ${enabled ? 'aktiviert' : 'deaktiviert'}`);
});

terminalMasterToggle.addEventListener('change', async () => {
  const terminalLogging = terminalMasterToggle.checked;
  severitySelect.disabled = !terminalLogging;
  await saveSettings({ terminalLogging });
  showToast(`[AnoFox] Konsolen-Logging ${terminalLogging ? 'aktiviert' : 'deaktiviert'}`);
});

severitySelect.addEventListener('change', async () => {
  const logSeverity = severitySelect.value as LogSeverity;
  await saveSettings({ logSeverity });
  showToast(`Allgemeines Log-Level auf ${logSeverity} gesetzt`);
});

// Render tracked params reference
function renderTrackedParams(): void {
  paramListEl.replaceChildren();
  for (const param of KNOWN_TRACKING_PARAMS) {
    const badge = document.createElement('span');
    badge.className = 'param-badge';
    badge.textContent = param;
    paramListEl.appendChild(badge);
  }
}

// ==========================================
// STATS & INSIGHTS & INTERNAL LOG RENDERING
// ==========================================

function renderBreakdownList(container: HTMLElement, data: Record<string, number>, emptyMsg: string): void {
  container.replaceChildren();
  const entries = Object.entries(data).sort((a, b) => b[1] - a[1]);

  if (entries.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = emptyMsg;
    container.appendChild(empty);
    return;
  }

  for (const [name, count] of entries) {
    const row = document.createElement('div');
    row.className = 'breakdown-row';

    const label = document.createElement('span');
    label.style.fontWeight = '500';
    label.textContent = name;

    const countBadge = document.createElement('span');
    countBadge.className = 'breakdown-count';
    countBadge.textContent = `${count}x`;

    row.appendChild(label);
    row.appendChild(countBadge);
    container.appendChild(row);
  }
}

function renderInsightsTable(items: BlockedItemRecord[]): void {
  insightsTableBody.replaceChildren();
  const filter = insightsSearchInput.value.trim().toLowerCase();

  const filtered = items.filter((item) => {
    if (!filter) return true;
    return (
      item.sourceSite.toLowerCase().includes(filter) ||
      item.target.toLowerCase().includes(filter) ||
      item.details.toLowerCase().includes(filter)
    );
  });

  if (filtered.length === 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 4;
    td.className = 'empty-state';
    td.textContent = items.length === 0 ? 'Noch keine Elemente in dieser Sitzung blockiert' : 'Keine passenden Einträge gefunden';
    tr.appendChild(td);
    insightsTableBody.appendChild(tr);
    return;
  }

  for (const item of filtered) {
    const tr = document.createElement('tr');

    const tdTime = document.createElement('td');
    tdTime.style.fontFamily = 'monospace';
    tdTime.style.color = 'var(--text-muted)';
    tdTime.textContent = item.timeFormatted;

    const tdType = document.createElement('td');
    const badge = document.createElement('span');
    badge.className = `badge-type ${item.type === 'TRACKING_PARAM' ? 'tracker' : 'embed'}`;
    badge.textContent = item.type === 'TRACKING_PARAM' ? 'URL-Tracker' : 'Social-Embed';
    tdType.appendChild(badge);

    const tdHost = document.createElement('td');
    tdHost.style.fontFamily = 'monospace';
    tdHost.style.fontWeight = '600';
    tdHost.textContent = item.sourceSite;

    const tdDetails = document.createElement('td');
    tdDetails.textContent = item.details;

    tr.appendChild(tdTime);
    tr.appendChild(tdType);
    tr.appendChild(tdHost);
    tr.appendChild(tdDetails);
    insightsTableBody.appendChild(tr);
  }
}

function renderInternalLogs(logs: InternalLogEntry[]): void {
  internalLogConsole.replaceChildren();
  const levelFilter = internalLogLevelFilter.value;

  const filtered = logs.filter((entry) => {
    if (levelFilter === 'ALL') return true;
    if (levelFilter === 'DEBUG') return true;
    if (levelFilter === 'INFO') return ['INFO', 'WARN', 'ERROR'].includes(entry.level);
    if (levelFilter === 'WARN') return ['WARN', 'ERROR'].includes(entry.level);
    if (levelFilter === 'ERROR') return entry.level === 'ERROR';
    return true;
  });

  if (filtered.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.style.color = '#64748b';
    empty.textContent = logs.length === 0 ? 'Keine internen Log-Einträge vorhanden.' : 'Keine Logs für diesen Filter.';
    internalLogConsole.appendChild(empty);
    return;
  }

  for (const entry of filtered) {
    const row = document.createElement('div');
    row.className = 'log-row';

    const time = document.createElement('span');
    time.className = 'log-time';
    time.textContent = entry.timeFormatted;

    const level = document.createElement('span');
    level.className = `log-level ${entry.level}`;
    level.textContent = entry.level;

    const cat = document.createElement('span');
    cat.className = 'log-cat';
    cat.textContent = `[${entry.category}]`;

    const content = document.createElement('div');
    content.className = 'log-msg';
    content.textContent = entry.message;

    if (entry.details) {
      const details = document.createElement('div');
      details.className = 'log-details';
      details.textContent = entry.details;
      content.appendChild(details);
    }

    row.appendChild(time);
    row.appendChild(level);
    row.appendChild(cat);
    row.appendChild(content);
    internalLogConsole.appendChild(row);
  }
}

async function fetchAndRenderStats(): Promise<void> {
  try {
    const res = await browser.runtime.sendMessage({ type: 'GET_STATS_AND_LOGS' });
    if (res?.success) {
      const isStatsActive = Boolean(res.statsEnabled);
      currentSettings.statsEnabled = isStatsActive;
      statsMasterToggle.checked = isStatsActive;

      if (!isStatsActive) {
        statsDisabledContainer.style.display = 'block';
        statsEnabledContainer.style.display = 'none';
        return;
      }

      statsDisabledContainer.style.display = 'none';
      statsEnabledContainer.style.display = 'block';

      cachedStatistics = res.statistics as StatisticsSnapshot;
      cachedInternalLogs = (res.internalLogs || []) as InternalLogEntry[];

      if (cachedStatistics) {
        statTotalBlocked.textContent = String(cachedStatistics.totalBlocked);
        statCleanedUrls.textContent = String(cachedStatistics.totalCleanedUrls);
        statCleanedParamsDesc.textContent = `${cachedStatistics.totalRemovedParams} Tracking-Parameter entfernt`;
        statBlockedEmbeds.textContent = String(cachedStatistics.totalBlockedEmbeds);

        renderBreakdownList(statsProvidersList, cachedStatistics.providersBreakdown, 'Noch keine Social Embeds blockiert');
        renderBreakdownList(statsParamsList, cachedStatistics.paramsBreakdown, 'Noch keine Parameter bereinigt');
        renderInsightsTable(cachedStatistics.recentBlockedItems);
      }

      renderInternalLogs(cachedInternalLogs);
    }
  } catch (err) {
    console.error('Fehler beim Abrufen der Statistiken:', err);
  }
}

// Stats event listeners
statsMasterToggle.addEventListener('change', async () => {
  const statsEnabled = statsMasterToggle.checked;
  currentSettings.statsEnabled = statsEnabled;
  await saveSettings({ statsEnabled });
  await fetchAndRenderStats();
  showToast(statsEnabled ? 'Temporäre Statistik & Internes Log aktiviert' : 'Statistikerfassung deaktiviert & Speicher geleert');
});

insightsSearchInput.addEventListener('input', () => {
  if (cachedStatistics) {
    renderInsightsTable(cachedStatistics.recentBlockedItems);
  }
});

internalLogLevelFilter.addEventListener('change', () => {
  renderInternalLogs(cachedInternalLogs);
});

btnRefreshStats.addEventListener('click', async () => {
  await fetchAndRenderStats();
  showToast('Statistiken & Logs aktualisiert');
});

btnClearStats.addEventListener('click', async () => {
  if (!confirm('Möchten Sie alle temporären Statistiken und internen Logs dieser Sitzung leeren?')) {
    return;
  }
  try {
    const res = await browser.runtime.sendMessage({ type: 'CLEAR_STATS_AND_LOGS' });
    if (res?.success) {
      await fetchAndRenderStats();
      showToast('Statistik & internes Log erfolgreich geleert');
    }
  } catch {
    showToast('Fehler beim Leeren');
  }
});

// Backup & Reset
btnExport.addEventListener('click', () => {
  const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(exportSettings(currentSettings));
  const dlAnchor = document.createElement('a');
  dlAnchor.setAttribute('href', dataStr);
  dlAnchor.setAttribute('download', 'anofox-settings.json');
  dlAnchor.click();
  showToast('Konfiguration erfolgreich exportiert');
});

btnImportTrigger.addEventListener('click', () => {
  importFileInput.click();
});

importFileInput.addEventListener('change', async () => {
  const file = importFileInput.files?.[0];
  if (!file) return;

  try {
    const text = await file.text();
    const res = await browser.runtime.sendMessage({ type: 'IMPORT_SETTINGS', text });
    if (!res?.success) {
      throw new Error(res?.error ?? 'Import fehlgeschlagen');
    }

    await init();
    showToast('Konfiguration erfolgreich importiert!');
  } catch (err) {
    console.error('Import-Fehler:', err);
    alert('Fehler beim Importieren: ' + (err instanceof Error ? err.message : 'Ungültige Datei') + '. Bestehende Einstellungen wurden nicht verändert.');
  } finally {
    importFileInput.value = '';
  }
});

btnReset.addEventListener('click', async () => {
  if (!confirm('Achtung: Dadurch werden alle Ausnahmelisten und Anpassungen auf die Standardwerte zurückgesetzt. Fortfahren?')) {
    return;
  }

  try {
    const res = await browser.runtime.sendMessage({ type: 'RESET_SETTINGS' });
    if (res?.success && res.settings) {
      currentSettings = res.settings;
      await init();
      showToast('Einstellungen erfolgreich auf Standard zurückgesetzt');
    }
  } catch (err) {
    showToast('Fehler beim Zurücksetzen');
  }
});

// Initialize Dashboard
async function init(): Promise<void> {
  try {
    const res = await browser.runtime.sendMessage({ type: 'GET_SETTINGS' });
    if (res?.success && res.settings) {
      currentSettings = res.settings;
    }
  } catch {
    // Keep local default
  }

  applyTheme(currentSettings.theme);

  embedsMasterToggle.checked = currentSettings.socialEmbedsEnabled;
  cleanerMasterToggle.checked = currentSettings.enabled;
  terminalMasterToggle.checked = currentSettings.terminalLogging;
  severitySelect.value = currentSettings.logSeverity;
  severitySelect.disabled = !currentSettings.terminalLogging;

  statsMasterToggle.checked = currentSettings.statsEnabled;

  renderProviders();
  updateEmbedDomainsUI();
  updateCleanerDomainsUI();
  renderTrackedParams();
  await fetchAndRenderStats();
}

const mount = (id: string) => document.querySelector<HTMLElement>(`#mount-${id}`)!;
const policyPanel = initPolicyPanel(
  { overview: mount('overview'), profiles: mount('profiles'), rules: mount('rules'), native: mount('native'), storage: mount('storage'),
    consent: mount('consent'), threat: mount('threat'), lists: mount('lists') },
  () => currentSettings,
  (s) => { currentSettings = s; },
  (m) => showToast(m),
  (tabId) => showTab(tabId, { focus: true })
);
showTab(location.hash.slice(1) || 'tab-overview', { updateHash: false });

void init();
