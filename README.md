<p align="center">
  <img src="logo.png" alt="AnoFox – Fuchs mit Sonnenbrille" width="180">
</p>

<h1 align="center">AnoFox</h1>

<p align="center">
  Lokale Privatsphäre- und Sicherheitskontrolle für Firefox.<br>
  Keine Cloud, keine Telemetrie, <strong>kein Anonymitätsversprechen</strong>.
</p>

<p align="center">
  <img alt="Version" src="https://img.shields.io/badge/version-0.1.0%20(in%20Entwicklung)-orange">
  <img alt="Lizenz" src="https://img.shields.io/badge/license-GPL--3.0--or--later-blue">
  <img alt="Firefox" src="https://img.shields.io/badge/Firefox-140%2B%20(Desktop)-ff7139">
</p>

> **Status: erste Version in Entwicklung (0.1.0).** Es gibt noch kein Release und kein Paket im Add-on-Store.
> Die Erweiterung ist lauffähig und wird Ende-zu-Ende in echtem Firefox getestet, aber noch nicht für den Alltagseinsatz
> freigegeben. Was funktioniert, was experimentell ist und was nicht möglich ist, steht ehrlich weiter unten.

## Was ist AnoFox?

AnoFox ist eine Firefox-Erweiterung (Manifest V3), die Tracking, Wiedererkennung und unnötige Datenspuren einschränkt.
Alles läuft lokal auf deinem Gerät. Jede Schutzfunktion ist in einem **Schutzprofil** (Balanced, Strict, Lockdown, Custom)
steuerbar, einzeln abschaltbar und mit Ausnahmen pro Website versehen.

Leitlinien:

- **Nur was nachweisbar funktioniert, wird als aktiv angezeigt.** Nicht umgesetzte Module sind in der Oberfläche gesperrt und
  gekennzeichnet; es gibt keine Schein-Schalter.
- **Erst messen, dann bauen.** Browser-Verhalten wird in echtem Firefox gemessen (siehe `docs/architecture/`), nicht aus
  Typdefinitionen geraten. Wo sich ein Schutz technisch nicht sauber umsetzen lässt (z. B. Navigator-Spoofing), wird er
  bewusst nicht ausgeliefert.
- **Sichere Standardwerte, keine überraschenden Löschungen.** Balanced löscht nichts und blockiert keine Skripte.

## Was AnoFox kann

Der Status bezieht sich auf **Firefox 158 (Desktop, macOS)**. „E2E“ heißt: von einer Testsuite mit der gebauten Erweiterung in
echtem Firefox belegt (`npm run test:e2e`, 32 Prüfungen).

| Bereich | Funktion | Status |
|---|---|---|
| **URL-Bereinigung** | Entfernt Tracking-Parameter (`utm_*`, `fbclid`, `gclid` …) **vor** der Anfrage; signierte/Auth-URLs (OAuth, SAML, S3 …) bleiben unangetastet; Ausnahmen pro Website | ✅ E2E |
| **Social Embed Guard** | Blockiert eingebettete Inhalte von YouTube, Instagram, TikTok, Facebook, X, Vimeo, Spotify, Twitch, SoundCloud vor dem Verbindungsaufbau; Platzhalter mit „Inhalt laden“; Freigabe pro Website | ✅ E2E (Blockade, Platzhalter, Ausnahmen mit Twitch); Klick-zum-Laden nicht automatisiert getestet |
| **Schutzprofile** | Balanced / Strict / Lockdown / Custom, Stufe je Modul, Profilwechsel löscht nie deine Ausnahmen | ✅ E2E |
| **Skript-Kontrolle** | Strict: Drittanbieter-Skripte blockiert (vor dem Netzwerk). Lockdown: gar kein JavaScript. Modul „Inline-Skripte & Eval“: Inline/Event-Handler/`eval`/Wasm per Content-Security-Policy (Strict: nur externe Quellen, Lockdown: nichts). Ausnahmen pro Website (dauerhaft/Sitzung/Tab) | ✅ E2E + Firefox-Tests der CSP-Wirkung |
| **Netzwerk-Firewall** | Drittanbieter-Frames/-Fonts (Strict) bzw. alle Drittanbieter-Ressourcen außer Bildern (Lockdown), Regeln pro Website/Ziel | ✅ Regeln per Modell und Firefox getestet |
| **Werbe-/Tracker-Filter** | Parser und DNR-Compiler für Filterlisten (EasyList, EasyPrivacy, AdGuard Base), `$important`, Ausnahmen, `$badfilter`, Host-Gruppierung, Kosmetik-Filter (Elemente ausblenden), „Werbeblocker auf dieser Website pausieren“ | 🧪 experimentell: E2E mit lokal eingespielter Liste; Netzwerk-Download und Regelkontingent in Firefox noch nicht E2E geprüft |
| **Listen-Updater** | HTTPS-Allowlist, ETag/Last-Modified, Größen-/Zeitlimits, Plausibilitätsprüfung, SHA-256, Rollback; ohne Cookies/Referrer/besuchte URLs | 🧪 Unit-getestet gegen Fakes |
| **Cookie Vault** | Richtlinie pro Website: persistent / Session / ephemeral; Bereinigung nach dem Schließen des letzten Tabs (je Container), beim Browserstart und manuell; partitionierte Cookies; Überprüfung des Ergebnisses | ✅ E2E (Tab schließen); Browserstart per Unit-Test |
| **Website-Speicher** | localStorage, IndexedDB und Service Worker nach Richtlinie löschen | ✅ Reichweite in Firefox gemessen; Grenzen siehe unten |
| **Native Firefox-Schutzfunktionen** | `resistFingerprinting`, WebRTC-IP-Weitergabe, Referer, Prefetch, Tracking-Schutz – mit Kontrolle von `levelOfControl`, Freigabe per `clear()` | ✅ E2E + Firefox-Messung |
| **Einstellungen** | Versioniertes Schema, Migration, validierter Import/Export mit Rollback, Reset | ✅ E2E |
| **Statistik/Log** | Optional, nur im Arbeitsspeicher, standardmäßig aus | ✅ |

Die genauen Messungen und Entscheidungen stehen in [`docs/architecture/`](docs/architecture/).

## Was AnoFox (noch) nicht kann

Noch nicht umgesetzt (geplant, siehe [Roadmap](docs/ROADMAP.md)):

- Cookie-Banner-Automatik (Consent Manager)
- Malware-/Phishing-Erkennung (Modul ist vorhanden, aber leer und in der Oberfläche gesperrt)
- Eigene Fingerprinting-Maßnahmen für Audio, Schriften, Hardware (nur native Firefox-Mechanismen sind aktiv)
- Click-to-Allow für einzelne blockierte Ressourcen, Script Inspector
- Vertrauenswürdige-Seiten-Verwaltung mit Container-Bindung und Wildcards in der Oberfläche
- Berechtigungskontrolle (Kamera, Standort …), Referrer-Trimming per Header, statische Regelsätze für sehr große Listen
- Die komplett neue, professionelle Oberfläche (aktuell: Popup, Optionsseite mit Schutzprofil-Tab)
- Firefox für Android, Windows und Linux sind **nicht** getestet

## Was grundsätzlich nicht (zuverlässig) möglich ist

Diese Grenzen kommen vom Browser bzw. vom Erweiterungsmodell, nicht von fehlendem Aufwand:

- **Navigator-Werte (User-Agent, Plattform, Sprache, Kernzahl) konsistent fälschen.** Worker, HTTP-Header und API-Spuren verraten
  die Manipulation; ein erkannter „Lügner“ ist auffälliger als der echte Wert. Gemessen und bewusst nicht ausgeliefert
  ([Begründung](docs/architecture/fingerprinting-normalization.md)).
- **TLS-/HTTP-2-/HTTP-3-Fingerabdruck** und andere Netzwerkmerkmale: für Erweiterungen nicht erreichbar.
- **Löschen beim Beenden des Browsers garantieren.** AnoFox merkt sich Bereinigungen und führt sie beim nächsten Start aus
  (Best Effort).
- **CacheStorage löschen**, **Drittanbieter-localStorage/-IndexedDB unter einer Website gezielt löschen**, Daten auf
  **Nicht-Standard-Ports** erfassen, **Speichern grundsätzlich verhindern** („restricted“). Details:
  [Löschreichweite](docs/architecture/storage-reach.md).
- **Einmal-Freigaben** per `declarativeNetRequest`, **Inline-Skripte überwachen**, **Scriptlets** und uBlock-spezifische Syntax
  vollständig übernehmen.
- **`resistFingerprinting` pro Website**: Die Einstellung wirkt browserweit und ändert u. a. Zeitzone (UTC) und Farbschema.
  Sie ändert **nicht** User-Agent, Plattform, Sprache, Audio oder Schriften.
- **Anonymität.** AnoFox reduziert Spuren und Angriffsfläche. Es verbirgt weder deine IP-Adresse noch macht es dich
  unauffindbar. Dafür braucht es VPN/Tor und mehr.

## Installation (Entwicklung)

Voraussetzungen: Node.js 22.6 oder neuer, npm, Firefox 140 oder neuer.

```bash
npm install
npm run build          # baut die Erweiterung nach dist/
npm run dev            # baut und startet Firefox mit der Erweiterung (web-ext)
```

Die Mindestversion Firefox 140 ergibt sich aus `data_collection_permissions`. Es gibt keine veröffentlichte Version.

## Tests

```bash
npm test               # 100+ Unit-Tests (Node-Testrunner, ohne Browser)
npm run typecheck      # TypeScript
npm run lint           # Typecheck + Build + web-ext lint
npm run test:e2e       # Ende-zu-Ende: gebaute Erweiterung in headless Firefox (ca. 3–4 Minuten)
npm run test:firefox   # Messungen/Regressionstests der Firefox-Fakten (CSP, privacy-API, Navigator, Löschreichweite)
```

Die Firefox-Suiten starten ein lokales Testsystem (virtuelle Hosts über einen lokalen PAC-Proxy, lokaler Server) und brauchen
keinen Internetzugang. Mit `FIREFOX_BIN=/Pfad/zu/firefox` lässt sich der Browser wählen; ohne Firefox werden sie übersprungen.
Die E2E-Suite prüft u. a., dass blockierte Anfragen den Server **nie erreichen**, dass Ausnahmen nur für die jeweilige
Website gelten, dass Lockdown wirklich kein JavaScript ausführt und dass Bereinigungen genau die vorgesehenen Daten treffen.

## Architektur

```
src/
├── core/               Policy-Engine, Einstellungen (Schema v2), Domain-Hilfen, Modul-Metadaten
├── protection/         network · adblock (Parser, Compiler, Updater, Kosmetik) · fingerprint (native) · storage (Cookie Vault)
├── browser/background/ Dienste mit Browserzugriff (Speicher-/Cookie-Dienst)
├── background.ts       Nachrichten, Regelanwendung (declarativeNetRequest), Dienste
├── content-*.ts        Content-Skripte (Embed Guard, Kosmetik-Filter)
├── popup.ts, options.ts, ui/  Oberfläche
test/                   Unit-Tests und test/firefox/ (echter Firefox)
docs/architecture/      Messungen, Fähigkeitenmatrix, Entscheidungen
```

Die Policy-Engine entscheidet deterministisch (Website vor global, konkretes Ziel vor allgemein, Blockieren vor Erlauben).
Eine Ausnahme gilt immer nur für **ihr** Modul: Eine Embed-Freigabe hebt keine Skript- oder Listenregel auf.
Siehe [`docs/architecture/policy.md`](docs/architecture/policy.md).

## Datenschutz und Berechtigungen

AnoFox sammelt, speichert und überträgt **keine** Nutzungsdaten (`data_collection_permissions: none`). Einstellungen liegen
lokal (`storage.local`). Das Netzwerk nutzt AnoFox ausschließlich zum **optionalen** Herunterladen der Filterlisten, die du
selbst aktivierst; der Listenanbieter sieht dabei deine IP-Adresse, aber keine besuchten URLs.

| Berechtigung | Wofür |
|---|---|
| `declarativeNetRequest`, Host `<all_urls>` | Anfragen vor dem Netzwerk blockieren, Parameter entfernen, CSP-Header anhängen |
| `storage`, `alarms` | Einstellungen, Bereinigungswarteschlange, Listenprüfung |
| `tabs`, `scripting` | Websites/Container erkennen, Ausnahmen, Kosmetik-Filter per `insertCSS` |
| `cookies`, `browsingData` | Cookie Vault (Bereinigung nach Richtlinie) |
| `privacy` | Native Firefox-Datenschutzeinstellungen (browserweit) |
| `webRequest`, `declarativeNetRequestFeedback` | Nur für das optionale Log bereinigter URLs; **Kandidaten zum Entfernen** (siehe Roadmap) |

## Mitwirken und Sicherheit

Fehler und Ideen als Issue. Sicherheitsrelevante Funde bitte nicht öffentlich, sondern direkt an die Projektbetreuer
(siehe [SECURITY.md](SECURITY.md)). Änderungen am Verhalten brauchen einen Test; Aussagen über Browserverhalten brauchen eine
Messung in echtem Firefox.

## Lizenz

AnoFox ist freie Software unter der **GNU General Public License v3.0 oder später** (`GPL-3.0-or-later`), siehe
[LICENSE](LICENSE). Firefox-Manifeste haben kein Lizenzfeld; die Lizenz gilt für den gesamten Quellbaum und die gebaute
Erweiterung. Filterlisten sind Daten Dritter mit eigenen Lizenzen (EasyList: GPLv3+ oder CC BY-SA 3.0+), siehe
[NOTICE.md](NOTICE.md). Die Listen werden **nicht** mitgeliefert, sondern zur Laufzeit geladen.

Änderungen: [CHANGELOG.md](CHANGELOG.md)
