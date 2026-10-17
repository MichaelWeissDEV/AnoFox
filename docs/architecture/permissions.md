# Phase 11: Berechtigungen, Public Suffix List, Mindestversion

## Berechtigungen (jede mit Begründung; `test/manifest.test.ts` erzwingt die Liste)
| Berechtigung | Wofür | Alternative? |
|---|---|---|
| `declarativeNetRequest` + Host `<all_urls>` | Anfragen vor dem Netzwerk blockieren/umleiten (Bereinigung, Embeds, Listen, Skripte, CSP-Header, Warnseite) | keine; DNR-Redirects und Header-Änderungen brauchen Host-Rechte |
| `storage` | Einstellungen, Listen-Zustand, Bereinigungswarteschlange (`storage.local`/`session`) | – |
| `alarms` | Listenprüfung, Bereinigungswarteschlange, Ablauf von Freigaben | `setTimeout` überlebt den Event-Page-Stopp nicht |
| `tabs` | Website/Container des Tabs erkennen (Cookie Vault, Ausnahmen, Popup) | `activeTab` reicht nicht (Hintergrund-Tabs, Tab-Schließen) |
| `scripting` | Kosmetik-Filter per `insertCSS` (umgeht Seiten-CSP) | Content-Skript-`<style>` kann an der CSP scheitern |
| `cookies`, `browsingData` | Cookie Vault: Cookies (inkl. partitioniert) und Website-Daten nach Richtlinie löschen | – |
| `privacy` | Native Firefox-Datenschutzeinstellungen (browserweit) | – |
| **`webRequest` (optional)** | Nur um bereinigte URLs zu zählen/loggen; wird beim Einschalten der Statistik **per Klick angefragt**, ohne sie läuft alles unverändert | – |

**Entfernt:** `declarativeNetRequestFeedback` (nur für das Debug-Event; nie benötigt) und `webRequest` als Pflichtberechtigung.

Messung (E2E-Testbuild mit `E2E_DROP_PERMS`, Firefox 158): Ohne `declarativeNetRequestFeedback` werden bereinigte URLs weiterhin gezählt; ohne `webRequest` bleibt der Zähler bei 0 und die URL wird trotzdem bereinigt. Der Zähler hängt also allein an `webRequest.onBeforeRedirect` (Firefox meldet DNR-Umleitungen darüber). Die E2E-Prüfung `permissions:` läuft in beiden Zuständen (`E2E_KEEP_OPTIONAL=1` simuliert „nicht erteilt“).

Weitere Verschärfungen: Content-Skripte laufen nur noch auf `http://*/*` und `https://*/*` (vorher `<all_urls>` inkl. `file:`/`ftp:`); die einzige per Web erreichbare Ressource ist `blocked.html`; keine eigene `content_security_policy`-Lockerung. Nicht reduzierbar: Host `<all_urls>`.

## Public Suffix List
Die kleine Übergangsliste in `domains.ts` ist ersetzt: `vendor/psl/public_suffix_list.dat` (unverändert, **MPL-2.0**, Version 2026-10-16) wird von `scripts/build-psl.mjs` in `src/core/domain-utils/psl-data.ts` überführt (10 080 normale, 311 Wildcard-, 8 Ausnahmeregeln, Punycode, ICANN **und** private Sektion, 147 KB). Umgesetzt ist der PSL-Algorithmus (Ausnahmen vor allem, längste Regel, Standardregel „*“). Wirkung: `registrableDomain`, Drittanbieter-Erkennung, Cookie Vault und Host-Abgleich folgen echten Site-Grenzen (`a.github.io` ≠ `b.github.io`, `*.ck`/`!www.ck`, IDN als Punycode); öffentliche Suffixe sind nie als Ausnahme-Eintrag gültig. Tests: `test/psl.test.ts` (Datenplausibilität, Algorithmus, Privat-Sektion, IDN, Geschwindigkeit). Aktualisieren: `node scripts/build-psl.mjs --update`. Die Content-Skripte enthalten die Daten nicht (Tree-Shaking verifiziert), nur Hintergrund und Popup (~150 KB).

## Echter Listen-Download (`npm run test:e2e:download`, braucht Internet)
Mit der gebauten Erweiterung in Firefox 158 gegen die echten Anbieter (Stand 2026-10-17):
- `urlhaus-online` und `phishing-filter` werden per HTTPS geladen, validiert, installiert; ein echter Listeneintrag führt zur Warnseite **vor** dem Netzwerk.
- EasyList + EasyPrivacy zusammen: 111 624 Filter → **3 643 Regeln** (Budget = 5 000 dynamisch − andere Regeln − 1 300 Reserve), **9 382 Filter abgeschnitten**, gemeldet als „partial“, 35 Threat-Regeln und insgesamt 3 700 / 5 000 dynamische Regeln. Die Quota-Grenze ist also **real**: EasyPrivacy wird praktisch nur teilweise wirksam. Abhilfe wären statische Rulesets (Build-Zeit-Kompilierung; erfordert Bündeln der Listen, Lizenzfrage) – offen.
- ETag/Last-Modified/SHA-256 werden gespeichert; Zurücksetzen entfernt alle Listenregeln (die lokale Userinfo-Warnregel 299990 gehört nicht dazu).
Diese Prüfungen laufen nur mit `E2E_NETWORK=1` und blockieren nie die Standard-Suite.

## Mindestversion
`strict_min_version` bleibt **140.0** (= aktuelle ESR): `data_collection_permissions` wird ab Firefox 140 unterstützt, ältere Versionen (≤ 127) lehnen den Schlüssel ab, ESR 115 warnt nur. Die API-Einführungsversionen der übrigen Funktionen (DNR `modifyHeaders` 128, `regexSubstitution`/`initiatorDomains` 113, `storage.session` 115, `scripting` 102, Cookies-`partitionKey`) konnten per Websuche nicht belegt werden (die MDN-Kompatibilitätstabellen liefen nicht durch); sie liegen nach vorliegender Information alle unter 140. **Getestet ist ausschließlich Firefox 158 (Desktop, macOS).** Nicht getestet: Firefox 140 ESR, Windows, Linux. **Android** wird nicht unterstützt (u. a. fehlt dort `privacy`, `browsingData` ist eingeschränkt); die `web-ext lint`-Warnung zu Android wird bewusst nicht durch einen Android-Eintrag „behoben“.
