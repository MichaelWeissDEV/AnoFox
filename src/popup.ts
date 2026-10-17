/**
 * AnoFox Popup Script
 * Quick controls for URL Tracking Cleaner, Social Embed Guard,
 * Website protection toggles, Theme switching, and one-click
 * link to the full Options & Lists Management Dashboard.
 */

import type { AnoFoxSettings, ThemePreference } from './background.ts';
import { PROFILE_INFO } from './core/capabilities/modules.ts';
import { hostMatches } from './core/domain-utils/domains.ts';
import { effectiveLevels } from './core/policy-engine/policy.ts';

let currentTabId: number | null = null;

// UI references
const themeToggleBtn = document.querySelector<HTMLButtonElement>('#theme-toggle-btn')!;
const openOptionsIconBtn = document.querySelector<HTMLButtonElement>('#btn-open-options-icon')!;
const openOptionsBtn = document.querySelector<HTMLButtonElement>('#btn-open-options')!;

const currentDomainEl = document.querySelector<HTMLElement>('#current-domain')!;
const toggleSiteBtn = document.querySelector<HTMLButtonElement>('#toggle-site-btn')!;
const badgeCleaner = document.querySelector<HTMLElement>('#badge-cleaner')!;
const badgeEmbed = document.querySelector<HTMLElement>('#badge-embed')!;

const cleanerCheckbox = document.querySelector<HTMLInputElement>('#cleaner-enabled')!;
const embedsCheckbox = document.querySelector<HTMLInputElement>('#embeds-enabled')!;
const terminalCheckbox = document.querySelector<HTMLInputElement>('#terminal-logging')!;
const statsCheckbox = document.querySelector<HTMLInputElement>('#stats-enabled')!;
const statsSummaryDesc = document.querySelector<HTMLElement>('#stats-summary-desc')!;

const profileSelect = document.querySelector<HTMLSelectElement>('#profile-select')!;
const profileDesc = document.querySelector<HTMLElement>('#profile-desc')!;
const siteRuleDuration = document.querySelector<HTMLSelectElement>('#site-rule-duration')!;
const allowScriptsBtn = document.querySelector<HTMLButtonElement>('#btn-allow-scripts')!;
const pauseAdblockBtn = document.querySelector<HTMLButtonElement>('#btn-pause-adblock')!;
const sitePolicySelect = document.querySelector<HTMLSelectElement>('#site-policy-select')!;
const sitePolicyDesc = document.querySelector<HTMLElement>('#site-policy-desc')!;
const pauseConsentBtn = document.querySelector<HTMLButtonElement>('#btn-pause-consent')!;
const siteRulesEl = document.querySelector<HTMLElement>('#site-rules')!;

const statusEl = document.querySelector<HTMLParagraphElement>('#status')!;

let currentTabDomain: string | null = null;
let currentSettings: AnoFoxSettings | null = null;
let statusTimeout: ReturnType<typeof setTimeout> | null = null;

function showStatus(text: string, isError: boolean = false): void {
  if (statusTimeout) clearTimeout(statusTimeout);
  statusEl.textContent = text;
  statusEl.style.color = isError ? 'var(--danger)' : 'var(--accent)';
  statusTimeout = setTimeout(() => {
    statusEl.textContent = '';
  }, 2200);
}

function applyTheme(theme: ThemePreference): void {
  const root = document.documentElement;
  const isDark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  root.setAttribute('data-theme', isDark ? 'dark' : 'light');
  themeToggleBtn.textContent = isDark ? '🌙' : '☀️';
  themeToggleBtn.title = isDark ? 'Zu hellem Design wechseln' : 'Zu dunklem Design wechseln';
}

function updateSiteUI(): void {
  if (!currentSettings) return;

  if (currentTabDomain) {
    currentDomainEl.textContent = currentTabDomain;
    const isCleanerExempt = currentSettings.exceptions.includes(currentTabDomain);
    const isEmbedExempt = currentSettings.socialEmbedExceptions.includes(currentTabDomain);
    const isAnyExempt = isCleanerExempt || isEmbedExempt;

    toggleSiteBtn.disabled = false;
    if (isAnyExempt) {
      toggleSiteBtn.textContent = 'Schutz aktivieren';
      toggleSiteBtn.classList.remove('btn-accent');
    } else {
      toggleSiteBtn.textContent = 'Ausnahme';
      toggleSiteBtn.classList.add('btn-accent');
    }

    badgeCleaner.textContent = isCleanerExempt ? 'Cleaner: Aus' : 'Cleaner: Aktiv';
    badgeCleaner.classList.toggle('active', !isCleanerExempt && currentSettings.enabled);

    badgeEmbed.textContent = isEmbedExempt ? 'Embeds: Erlaubt' : 'Embeds: Geschützt';
    badgeEmbed.classList.toggle('active', !isEmbedExempt && currentSettings.socialEmbedsEnabled);
  } else {
    currentDomainEl.textContent = 'Keine aktive Website';
    toggleSiteBtn.disabled = true;
    toggleSiteBtn.textContent = 'Keine Website';
    badgeCleaner.textContent = 'Cleaner: -';
    badgeEmbed.textContent = 'Embeds: -';
  }
}

function updatePolicyUI(): void {
  if (!currentSettings) return;
  profileSelect.value = currentSettings.profile;
  profileDesc.textContent = PROFILE_INFO[currentSettings.profile].description;
  allowScriptsBtn.disabled = !currentTabDomain;
  pauseAdblockBtn.disabled = !currentTabDomain;
  pauseConsentBtn.disabled = !currentTabDomain;
  siteRulesEl.replaceChildren();
  if (!currentTabDomain) return;
  const domain = currentTabDomain;
  for (const rule of currentSettings.rules) {
    if ((rule.module !== 'scripts' && rule.module !== 'adblock' && rule.module !== 'consent') || rule.scope.kind !== 'site' || !hostMatches(domain, rule.scope.site)) continue;
    const row = document.createElement('div');
    const text = document.createElement('span');
    const dur = rule.duration === 'permanent' ? 'dauerhaft' : rule.duration === 'session' ? 'bis Browserende' : 'bis Tab zu';
    text.textContent = rule.module === 'consent'
      ? `Banner-Automatik aus (${dur})`
      : rule.module === 'adblock'
      ? `Werbeblocker pausiert (${dur})`
      : `${rule.effect === 'allow' ? 'Skripte erlaubt' : 'Skripte blockiert'} (${dur})`;
    const del = document.createElement('button');
    del.type = 'button';
    del.textContent = '✕';
    del.title = 'Regel entfernen';
    del.setAttribute('aria-label', 'Regel entfernen');
    del.addEventListener('click', async () => {
      // a scripts exception is paired with an inline-script exception (same site and duration); remove both
      const ids = [rule.id];
      if (rule.module === 'scripts' && currentSettings) {
        for (const other of currentSettings.rules) {
          if (other.module === 'inline' && other.scope.kind === 'site' && rule.scope.kind === 'site' &&
              other.scope.site === rule.scope.site && other.duration === rule.duration && other.effect === rule.effect) ids.push(other.id);
        }
      }
      let res: { success?: boolean } | undefined;
      for (const id of ids) res = await browser.runtime.sendMessage({ type: 'REMOVE_USER_RULE', id });
      if (res?.success) { await reloadSettings(); showStatus('Regel entfernt'); } else showStatus('Fehler beim Entfernen', true);
    });
    row.append(text, del);
    siteRulesEl.append(row);
  }
}

async function updateStoragePolicyUI(): Promise<void> {
  if (!currentTabDomain) { sitePolicySelect.disabled = true; sitePolicyDesc.textContent = 'Keine Website'; return; }
  try {
    const res = await browser.runtime.sendMessage({ type: 'GET_STORAGE_STATUS', host: currentTabDomain });
    if (!res?.success) return;
    const own = Object.keys(res.sitePolicies as Record<string, string>).find((k) => k === currentTabDomain || currentTabDomain!.endsWith('.' + k));
    sitePolicySelect.value = own && (res.sitePolicies as Record<string, string>)[own] !== 'restricted' ? (res.sitePolicies as Record<string, string>)[own] : '';
    sitePolicySelect.disabled = false;
    const c = res.status.cookies as { total: number; session: number; persistent: number; partitioned: number } | undefined;
    sitePolicyDesc.textContent = `${c ? `${c.total} Cookies (${c.persistent} dauerhaft, ${c.partitioned} partitioniert) · ` : ''}aktuell: ${res.status.policy}${res.status.active ? '' : ' (Module aus)'}`;
  } catch { sitePolicyDesc.textContent = 'Status nicht verfügbar'; }
}

async function reloadSettings(): Promise<void> {
  const response = await browser.runtime.sendMessage({ type: 'GET_SETTINGS' });
  if (response?.success && response.settings) {
    currentSettings = response.settings;
    updateSiteUI();
    updatePolicyUI();
    void updateStoragePolicyUI();
  }
}

async function sendSettingsUpdate(updates: Partial<AnoFoxSettings>): Promise<void> {
  try {
    const response = await browser.runtime.sendMessage({
      type: 'UPDATE_SETTINGS',
      settings: updates
    });
    if (response?.success && response.settings) {
      currentSettings = response.settings;
      updateSiteUI();
    }
  } catch (error) {
    console.error('Fehler beim Aktualisieren der Einstellungen:', error);
    showStatus('Fehler beim Speichern', true);
  }
}

async function openDashboard(): Promise<void> {
  try {
    if (browser.runtime.openOptionsPage) {
      await browser.runtime.openOptionsPage();
    } else {
      await browser.tabs.create({ url: browser.runtime.getURL('options.html') });
    }
    window.close();
  } catch {
    await browser.tabs.create({ url: 'options.html' });
    window.close();
  }
}

async function init(): Promise<void> {
  // 1. Identify active tab host
  try {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    const activeTab = tabs[0];
    currentTabId = activeTab?.id ?? null;
    if (activeTab?.url) {
      const url = new URL(activeTab.url);
      if (['http:', 'https:'].includes(url.protocol)) {
        currentTabDomain = url.hostname.toLowerCase();
      } else {
        currentTabDomain = null;
      }
    }
  } catch {
    currentTabDomain = null;
  }

  // 2. Fetch settings
  try {
    const response = await browser.runtime.sendMessage({ type: 'GET_SETTINGS' });
    if (response?.success && response.settings) {
      currentSettings = response.settings;
    }
  } catch (err) {
    console.warn('AnoFox: Konnte Einstellungen nicht vom Hintergrund abfragen:', err);
  }

  if (currentSettings) {
    applyTheme(currentSettings.theme);
    cleanerCheckbox.checked = currentSettings.enabled;
    embedsCheckbox.checked = currentSettings.socialEmbedsEnabled;
    terminalCheckbox.checked = currentSettings.terminalLogging;
    statsCheckbox.checked = currentSettings.statsEnabled;

    if (currentSettings.statsEnabled) {
      try {
        const statsRes = await browser.runtime.sendMessage({ type: 'GET_STATS_AND_LOGS' });
        if (statsRes?.success && statsRes.statistics) {
          const total = statsRes.statistics.totalBlocked;
          statsSummaryDesc.textContent = `${total} blockiert (flüchtig im RAM)`;
        } else {
          statsSummaryDesc.textContent = 'Aktiv • Flüchtig im RAM';
        }
      } catch {
        statsSummaryDesc.textContent = 'Aktiv • Flüchtig im RAM';
      }
    } else {
      statsSummaryDesc.textContent = 'Standard: Aus • Keine Datenspeicherung';
    }

    updateSiteUI();
    updatePolicyUI();
    void updateStoragePolicyUI();
  }
}

// Quick toggles
cleanerCheckbox.addEventListener('change', async () => {
  const enabled = cleanerCheckbox.checked;
  await sendSettingsUpdate({ enabled });
  showStatus(enabled ? 'Tracking-Bereinigung aktiv' : 'Tracking-Bereinigung deaktiviert');
});

embedsCheckbox.addEventListener('change', async () => {
  const socialEmbedsEnabled = embedsCheckbox.checked;
  await sendSettingsUpdate({ socialEmbedsEnabled });
  showStatus(socialEmbedsEnabled ? 'Social Embed Guard aktiv' : 'Embed Guard pausiert');
});

terminalCheckbox.addEventListener('change', async () => {
  const terminalLogging = terminalCheckbox.checked;
  await sendSettingsUpdate({ terminalLogging });
  showStatus(terminalLogging ? '[AnoFox] Konsole-Logs aktiv' : 'Konsole-Logs deaktiviert');
});

statsCheckbox.addEventListener('change', async () => {
  const statsEnabled = statsCheckbox.checked;
  await sendSettingsUpdate({ statsEnabled });
  if (statsEnabled) {
    statsSummaryDesc.textContent = 'Aktiv • Flüchtig im RAM';
    showStatus('Temporäre Statistik aktiviert');
  } else {
    statsSummaryDesc.textContent = 'Standard: Aus • Keine Datenspeicherung';
    showStatus('Statistikerfassung deaktiviert');
  }
});

// Quick toggle current site in exceptions
toggleSiteBtn.addEventListener('click', async () => {
  if (!currentTabDomain || !currentSettings) return;

  try {
    toggleSiteBtn.disabled = true;
    const isExempt = currentSettings.exceptions.includes(currentTabDomain) ||
                    currentSettings.socialEmbedExceptions.includes(currentTabDomain);

    let newExceptions = [...currentSettings.exceptions];
    let newEmbedExceptions = [...currentSettings.socialEmbedExceptions];

    if (isExempt) {
      // Remove exemption (enable protection)
      newExceptions = newExceptions.filter((d) => d !== currentTabDomain);
      newEmbedExceptions = newEmbedExceptions.filter((d) => d !== currentTabDomain);
      showStatus(`Schutz für ${currentTabDomain} wieder aktiv`);
    } else {
      // Add exemption
      if (!newExceptions.includes(currentTabDomain)) newExceptions.push(currentTabDomain);
      if (!newEmbedExceptions.includes(currentTabDomain)) newEmbedExceptions.push(currentTabDomain);
      showStatus(`Ausnahme für ${currentTabDomain} gespeichert`);
    }

    await sendSettingsUpdate({
      exceptions: newExceptions,
      socialEmbedExceptions: newEmbedExceptions
    });
  } catch (err) {
    showStatus('Fehler beim Ändern der Ausnahme', true);
  } finally {
    toggleSiteBtn.disabled = false;
  }
});

profileSelect.addEventListener('change', async () => {
  const res = await browser.runtime.sendMessage({ type: 'SET_PROFILE', profile: profileSelect.value });
  if (res?.success) showStatus(`Profil: ${PROFILE_INFO[res.profile as keyof typeof PROFILE_INFO].label}`);
  else showStatus('Profilwechsel fehlgeschlagen', true);
  await reloadSettings();
});

allowScriptsBtn.addEventListener('click', async () => {
  if (!currentTabDomain) return;
  const duration = siteRuleDuration.value;
  if (duration === 'tab' && currentTabId === null) { showStatus('Kein Tab erkannt', true); return; }
  const inlineActive = currentSettings ? effectiveLevels({ profile: currentSettings.profile, customLevels: currentSettings.customLevels, rules: [] }).inline !== 'off' : false;
  if (inlineActive && duration === 'tab') {
    // CSP exceptions are per site, not per tab: refuse instead of leaving the page half-unlocked
    showStatus('Inline-Skripte sind blockiert: „Bis Browserende“ oder „Dauerhaft“ wählen', true);
    return;
  }
  allowScriptsBtn.disabled = true;
  try {
    const base = { effect: 'allow', duration, scope: { kind: 'site', site: currentTabDomain }, ...(duration === 'tab' ? { tabId: currentTabId } : {}) };
    const res = await browser.runtime.sendMessage({ type: 'ADD_USER_RULE', rule: { module: 'scripts', ...base } });
    if (res?.success && inlineActive) {
      await browser.runtime.sendMessage({ type: 'ADD_USER_RULE', rule: { module: 'inline', ...base } });
    }
    if (res?.success) {
      showStatus(currentSettings && ['strict', 'lockdown'].includes(currentSettings.profile)
        ? 'Skripte erlaubt – Seite neu laden' : 'Regel gespeichert (Profil blockiert keine Skripte)');
    } else showStatus(res?.error ?? 'Fehler', true);
    await reloadSettings();
  } finally {
    allowScriptsBtn.disabled = !currentTabDomain;
  }
});

pauseAdblockBtn.addEventListener('click', async () => {
  if (!currentTabDomain) return;
  const duration = siteRuleDuration.value;
  if (duration === 'tab' && currentTabId === null) { showStatus('Kein Tab erkannt', true); return; }
  pauseAdblockBtn.disabled = true;
  try {
    const res = await browser.runtime.sendMessage({
      type: 'ADD_USER_RULE',
      rule: {
        module: 'adblock', effect: 'allow', duration,
        scope: { kind: 'site', site: currentTabDomain },
        ...(duration === 'tab' ? { tabId: currentTabId } : {})
      }
    });
    showStatus(res?.success ? 'Werbeblocker pausiert – Seite neu laden' : (res?.error ?? 'Fehler'), !res?.success);
    await reloadSettings();
  } finally {
    pauseAdblockBtn.disabled = !currentTabDomain;
  }
});

sitePolicySelect.addEventListener('change', async () => {
  if (!currentTabDomain) return;
  const policy = sitePolicySelect.value || null;
  const res = await browser.runtime.sendMessage({ type: 'SET_SITE_POLICY', site: currentTabDomain, policy });
  showStatus(res?.success ? (policy ? `Richtlinie „${policy}“ gespeichert` : 'Standardrichtlinie') : (res?.error ?? 'Fehler'), !res?.success);
  await updateStoragePolicyUI();
});

pauseConsentBtn.addEventListener('click', async () => {
  if (!currentTabDomain) return;
  const duration = siteRuleDuration.value;
  if (duration === 'tab' && currentTabId === null) { showStatus('Kein Tab erkannt', true); return; }
  pauseConsentBtn.disabled = true;
  try {
    const res = await browser.runtime.sendMessage({
      type: 'ADD_USER_RULE',
      rule: { module: 'consent', effect: 'allow', duration, scope: { kind: 'site', site: currentTabDomain }, ...(duration === 'tab' ? { tabId: currentTabId } : {}) }
    });
    showStatus(res?.success ? 'Banner-Automatik für diese Website aus – Seite neu laden' : (res?.error ?? 'Fehler'), !res?.success);
    await reloadSettings();
  } finally {
    pauseConsentBtn.disabled = !currentTabDomain;
  }
});

// Theme switcher button
themeToggleBtn.addEventListener('click', async () => {
  if (!currentSettings) return;
  const nextTheme: ThemePreference = currentSettings.theme === 'light' ? 'dark' : 'light';
  currentSettings.theme = nextTheme;
  applyTheme(nextTheme);
  await sendSettingsUpdate({ theme: nextTheme });
  showStatus(`Design auf ${nextTheme === 'dark' ? 'Dunkel' : 'Hell'} gewechselt`);
});

// Open management dashboard in a new tab
openOptionsBtn.addEventListener('click', () => void openDashboard());
openOptionsIconBtn.addEventListener('click', () => void openDashboard());

void init();
