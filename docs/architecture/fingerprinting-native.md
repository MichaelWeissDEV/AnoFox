# Anti-Fingerprinting Phase 5.1: native Firefox-Mechanismen (gemessen)

Messung: `npm run test:firefox:privacy` (headless **Firefox 158.0**, macOS, temporäres Profil, Zeitzone Europe/Berlin, lokale Testseite `test/firefox/privacy/server.mjs`). Rohdaten einer Messung wurden ausgewertet; **Headless-Firefox liefert teils synthetische Werte** (Fenster-/Bildschirmgröße 300×150 unter RFP, DPR 2). Werte sind Beispiele, die Aussagen unten stützen sich auf Unterschiede und Invarianten.

## `browser.privacy.*`: Verfügbarkeit und `levelOfControl` (Firefox 158, Standardprofil)
| Einstellung | Standardwert | levelOfControl | Anmerkung |
|---|---|---|---|
| `websites.resistFingerprinting` | false | controllable | setzbar, danach `controlled_by_this_extension` |
| `network.webRTCIPHandlingPolicy` | `default` | controllable | `default_public_interface_only`, `disable_non_proxied_udp` setzbar |
| `websites.referrersEnabled` | true | controllable | false entfernt Referer (gemessen) |
| `network.networkPredictionEnabled` | true | controllable | |
| `websites.trackingProtectionMode` | `private_browsing` | controllable | `always` setzbar |
| `websites.hyperlinkAuditingEnabled` | false | controllable | in Firefox bereits aus |
| `websites.cookieConfig` | `reject_trackers_and_partition_foreign` | controllable | Standard ist bereits Total Cookie Protection; `reject_third_party` setzbar (bricht SSO) |
| `websites.firstPartyIsolate` | false | controllable | **Aktivieren schlägt fehl**, solange `cookieBehavior` partitioniert → nicht anbieten |
| `network.peerConnectionEnabled` | true | controllable | nicht verwendet (bricht WebRTC komplett) |
| `network.httpsOnlyMode` | `never` | **not_controllable** | Setzen wirkungslos → nicht anbieten |
| `network.tlsVersionRestrict`, `websites.thirdPartyCookiesAllowed`, `websites.protectedContentEnabled` | – | **fehlen** | in 158 nicht vorhanden |
| `services.passwordSavingEnabled` | false | controllable | außerhalb des Projektumfangs |

Wichtige Verhaltensregel (gemessen): Nach `set(defaultwert)` bleibt `controlled_by_this_extension`; **nur `clear()` gibt die Kontrolle zurück** (`controllable_by_this_extension`). AnoFox nutzt deshalb ausschließlich `clear()` und fasst nie Einstellungen an, die bereits den Zielwert haben.

## Wirkung von `resistFingerprinting` (RFP) – gemessen
Geändert (Baseline → RFP): Zeitzone Europe/Berlin → UTC (Offset 0), Canvas-Hash ändert sich, `getImageData` liefert Rauschen statt exakter Pixel, WebGL-Renderer „Apple M1“ → „Mozilla“ (Vendor/Renderer generisch, `MAX_TEXTURE_SIZE` kleiner), `prefers-color-scheme` dunkel → hell, `hardwareConcurrency` 16 → 8 (nicht 2), Bildschirm-/Fenstergröße gerundet bzw. generisch (headless-Artefakt: 300×150), DPR geändert.

**Unverändert unter RFP in dieser Messung:** User-Agent, `navigator.platform`/`oscpu`/`appVersion`/`buildID`, Sprachen und Locale (kein `spoof_english`), Schriftenerkennung (Canvas-Messung), Audio-Fingerprint (OfflineAudioContext), `speechSynthesis`-Stimmen, Medienformate (`canPlayType`), Plugins, `doNotTrack`. Die Timer-Messung (`performance.now`, `Date.now`) war nicht aussagekräftig und wird nicht bewertet. Nebenwirkung: `enumerateDevices` lief in einem Lauf in ein Timeout.
→ RFP allein deckt Grafik/Zeit/Anzeige teilweise ab, **nicht** Audio, Fonts, UA/Plattform, Sprache. Diese bleiben Aufgabe eigener, nachweisbar konsistenter Maßnahmen (5.3) – bisher nicht implementiert.

## Weitere Messungen
- **WebRTC:** Standard liefert 5 ICE-Kandidaten, aber nur mDNS-Namen (`*.local`), **keinen IP-Literal-Leak**. `disable_non_proxied_udp` und `default_public_interface_only` reduzieren auf 1 Kandidat, ebenfalls ohne IP-Literal. Anrufe können dadurch fehlschlagen.
- **Referer:** Standard sendet die volle Seiten-URL bei same-origin; mit `referrersEnabled=false` kein Header.
- Nicht gemessen: Wirkung auf bekannte Fingerprinting-Dienste, Verhalten in anderen Betriebssystemen, Firefox-eigener `privacy.fingerprintingProtection` (nicht über Erweiterungen setzbar).

## Umsetzung in AnoFox (`src/protection/fingerprint/native.ts`)
- Gesteuert über die Stufe des Moduls `fingerprint` + Überschreibung pro Einstellung (`Automatisch` / `Immer schützen` / `Nie ändern`).
  - balanced: nur Hyperlink-Auditing absichern (Firefox-Standard, daher keine Änderung)
  - strict: RFP an, WebRTC nur öffentliche Schnittstelle, Vorab-Verbindungen aus, Tracking-Schutz immer
  - lockdown: zusätzlich WebRTC ohne nicht-proxied UDP und Referer aus
- Planer liest `levelOfControl`, setzt nur bei Abweichung, verifiziert den Wert danach, meldet `blocked` / `unavailable` / `error` ehrlich und lässt fremd gesteuerte Einstellungen unberührt.
- UI: Abschnitt „Native Firefox-Einstellungen (gelten für den ganzen Browser)“ mit Ist-/Zielwert, Kontrollstatus und Nebenwirkungen.
- Neue Berechtigung `privacy` (Installationshinweis „Datenschutzeinstellungen ändern“).
- Einstellungen werden von Firefox beim Deinstallieren der Erweiterung automatisch freigegeben.

## Offen für Phase 5
- 5.2/5.3: eigene Maßnahmen für Audio, Fonts, UA/Plattform, Sprache, Hardware nur mit Konsistenz- und Nachweis-Tests (Testseite aus dieser Messung ist der Anfang).
- 5.5: MAIN-World-Injektion (`scripting.registerContentScripts` mit `world: "MAIN"`) bewerten (Erkennbarkeit, Worker-Lücke).
- Vergleich der Schutzwirkung gegen ein Firefox ohne AnoFox auf mehreren Systemen (nicht nur headless).
