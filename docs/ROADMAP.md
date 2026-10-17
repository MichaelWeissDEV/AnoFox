# Roadmap

Legende: ✅ umgesetzt und getestet · 🧪 umgesetzt, experimentell/teilweise geprüft · ⏳ geplant · ⛔ technisch nicht (zuverlässig) möglich

| Phase | Thema | Stand |
|---|---|---|
| 0 | Bestandsaufnahme, Fähigkeitenmatrix | ✅ |
| 1 | Policy-Engine, Profile, Einstellungsschema, Import/Export | ✅ |
| 2 | Netzwerk-Firewall (Drittanbieter, Regeln, Prioritätsbänder) | ✅ Header-Privacy (Referrer-Trimming per Header, ETag) ⏳ |
| 3 | Werbe-/Tracker-Filter | 🧪 Parser, Compiler, Updater, Kosmetik; ⏳ statische Rulesets, echter Listen-Download in Firefox prüfen, Regelkontingent messen, uBlock-Parallelbetrieb |
| 4 | Script-Control | ✅ extern + CSP-Inline/eval/Wasm; ⏳ Click-to-Allow, Script Inspector; ⛔ Einmal-Freigaben, Inline-Überwachung |
| 5 | Anti-Fingerprinting | 🧪 native Mechanismen; ⛔ Navigator-Normalisierung (nachweislich erkennbar); ⏳ Canvas/WebGL/Audio-Maßnahmen nur mit Wirkungs- und Konsistenznachweis |
| 6 | Cookie Vault / Speicher | ✅ Kern + E2E; ⏳ Allowlist mit Container/Wildcards in der UI, Datenalter, Drittanbieter-Sweep, SSO-Prüfung |
| 7 | Consent-Manager (CMP-Adapter, Modi Manual/Reject/Hide) | 🧪 umgesetzt, E2E mit nachgebauten Dialogen; ⏳ Live-Anbieter prüfen, iFrame-Banner (Sourcepoint) |
| 8 | Phishing-/Malware-URLs, Navigationsschutz | 🧪 lokale Listen, Warnseite, Userinfo-Warnung, E2E; ⏳ IDN/Homographen, echter Download im Browser, Lizenz vor Release erneut prüfen |
| 9 | Social-Tracking erweitern, Berechtigungen (Kamera/Standort …) | ⏳ |
| 10 | Neue Oberfläche (Dashboard, Komponenten), Barrierefreiheit | ✅ Dashboard, Popup, Warnseite, Tokens, Struktur-/Kontrast-/Responsiv-Tests; ⏳ alte Bereiche auf Komponenten umstellen, Screenreader-Test, Zoom/Kontrastmodus |
| 11 | Härtung: Berechtigungen reduzieren (`webRequest`, `declarativeNetRequestFeedback`), PSL, Mindestversionen, Windows/Linux/Android prüfen | ⏳ |

## Prinzipien für neue Funktionen

1. Erst Machbarkeit **in echtem Firefox messen** (`test/firefox/`), Ergebnis in `docs/architecture/` festhalten.
2. Capability-Eintrag mit Berechtigung, Reichweite, Grenzen und Testverweis.
3. Unit-Tests für die reine Logik, E2E-Prüfung (`test/firefox/e2e`) für das Verhalten im Browser.
4. Keine Schein-Schalter: ohne Nachweis bleibt ein Modul gesperrt und gekennzeichnet.
