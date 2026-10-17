/**
 * Truthful per-module metadata for the UI. `enforced` is only true where a tested enforcement
 * path exists in this build; the UI disables controls and labels everything else "nicht implementiert".
 */
import type { ModuleId, ProfileId } from '../policy-engine/policy.ts';

export interface ModuleInfo {
  label: string;
  description: string;
  enforced: boolean;
  /** How it is enforced / what the limits are (shown to the user). */
  note: string;
}

export const MODULE_INFO: Record<ModuleId, ModuleInfo> = {
  malware: { label: 'Malware', description: 'Bekannte Malware-Ziele blockieren.', enforced: false, note: 'Noch nicht implementiert (Phase 3).' },
  phishing: { label: 'Phishing', description: 'Verdächtige URLs erkennen.', enforced: false, note: 'Noch nicht implementiert.' },
  network: { label: 'Netzwerk-Firewall', description: 'Drittanbieter-Frames, -Fonts und weitere Ressourcen (ohne Skripte).', enforced: true, note: 'declarativeNetRequest, blockiert vor der Anfrage. Strict: Frames/Fonts, Lockdown: alles außer Bilder und Skripte.' },
  scripts: { label: 'Skripte', description: 'Externe JavaScript-Dateien kontrollieren.', enforced: true, note: 'Externe Skripte über Netzwerkregeln. Inline-Skripte kontrolliert das Modul „Inline-Skripte & Eval“.' },
  inline: { label: 'Inline-Skripte & Eval', description: 'Inline-Skripte, Event-Handler, eval und Wasm per Content-Security-Policy unterbinden.', enforced: true, note: 'In Firefox 158 geprüft (CSP-Header per declarativeNetRequest). Strict: nur externe Quellen, kein Inline/eval. Lockdown: gar kein JavaScript, Wirkung beim nächsten Laden der Seite. Seiten funktionieren oft nicht.' },
  social: { label: 'Social Embeds', description: 'Social-Media-Einbettungen blockieren (Klick zum Laden).', enforced: true, note: 'declarativeNetRequest + Platzhalter im Top-Frame.' },
  adblock: { label: 'Werbeblocker', description: 'Filterlisten (EasyList u. a.).', enforced: false, note: 'Experimentell: Parser, Compiler und Listen-Updater vorhanden (siehe Filterlisten unten), noch nicht in Firefox verifiziert. Keine Stufen.' },
  tracking: { label: 'URL-Tracking-Bereinigung', description: 'Tracking-Parameter aus Links entfernen.', enforced: true, note: 'declarativeNetRequest queryTransform für Hauptseiten und Frames.' },
  fingerprint: { label: 'Fingerprinting-Schutz', description: 'Native Firefox-Schutzfunktionen (browserweit): resistFingerprinting, WebRTC, Referer u. a.', enforced: true, note: 'Nur native Firefox-Einstellungen über browser.privacy (browserweit, nie pro Website). Eigene Maßnahmen für Canvas/WebGL/Audio sind noch nicht implementiert.' },
  cookies: { label: 'Cookies', description: 'Cookies nach Website-Richtlinie (Persistent/Session/Ephemeral) bereinigen.', enforced: true, note: 'Bereinigung über die cookies-API inkl. partitionierter Cookies, beim Schließen des letzten Tabs und beim Browserstart (Best Effort, kein Löschen beim Beenden garantiert). Strict: Standard „Session“, Lockdown: „Ephemeral“, Balanced: nichts löschen.' },
  storage: { label: 'Website-Speicher', description: 'localStorage, IndexedDB und Service Worker nach Website-Richtlinie bereinigen.', enforced: true, note: 'Per browsingData nach Hostname. Nicht möglich: CacheStorage, Drittanbieter-Partitionen unter einer Website, Daten auf Nicht-Standard-Ports; Service Worker nur wenn die Website in keinem Container offen ist.' },
  consent: { label: 'Cookie-Banner', description: 'Einwilligungsdialoge behandeln.', enforced: false, note: 'Noch nicht implementiert (Phase 7).' }
};

export const PROFILE_INFO: Record<ProfileId, { label: string; description: string }> = {
  balanced: { label: 'Balanced', description: 'Tracking-Bereinigung und Embed-Schutz; Skripte und Netzwerk bleiben unbeschränkt.' },
  strict: { label: 'Strict', description: 'Zusätzlich: Drittanbieter-Skripte, -Frames und -Fonts werden blockiert.' },
  lockdown: { label: 'Lockdown', description: 'Alle Skripte und alle Drittanbieter-Ressourcen außer Bildern sind blockiert; Freigaben nötig. Viele Seiten funktionieren nicht.' },
  custom: { label: 'Custom', description: 'Eigene Stufe pro Modul. Wird automatisch gewählt, sobald ein Modul einzeln geändert wird.' }
};

export const LEVEL_LABEL = { off: 'Aus', balanced: 'Balanced', strict: 'Strict', lockdown: 'Lockdown' } as const;
