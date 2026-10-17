# Script Control (Phase 4): Machbarkeit und Durchsetzung

Alle Aussagen mit „getestet“ stammen aus `npm run test:firefox:csp` (headless Firefox **158.0**, Probe-Erweiterung + AnoFox-Compiler-Ausgabe, lokale Testseiten). Ältere Firefox-Versionen sind **nicht** getestet (`strict_min_version` bleibt entsprechend zu klären, MDN/Foren nennen 128 für `modifyHeaders`).

## Ergebnis der Machbarkeitsprüfung
| Mechanismus | Ergebnis |
|---|---|
| `webRequest.onHeadersReceived` (blocking) zum Anhängen von CSP | **Nicht nutzbar**: Listener wurde in der MV3-Erweiterung nie aufgerufen (0 Aufrufe, `X-Probe`-Header nie sichtbar). Ursache nicht geklärt, daher nicht verwendet. |
| DNR `modifyHeaders` + `append` CSP | **Funktioniert**, für `main_frame` und `sub_frame`, auch zusammen mit eigener CSP der Seite (Schnittmenge) und mit mehreren Regeln (alle gelten). |
| DNR `modifyHeaders` + `set` CSP | Funktioniert, würde aber die Seiten-CSP **ersetzen** → nie verwenden. |
| DNR `allow` über CSP-Regel | Höhere/gleiche Priorität hebt CSP-Regel auf, niedrigere nicht. **Aber** eine `allow`-Regel auf Dokumentanfragen würde auch Netzwerk-/Listen-Blocks derselben Anfragen aufheben → AnoFox nutzt stattdessen `excludedRequestDomains` an den CSP-Regeln. |
| Regeländerung | Wirkt nur auf neu geladene Dokumente (bereits geladene Seiten behalten ihre Richtlinie; nach Entfernen ist ein Reload nötig). |

## CSP-Werte und gemessene Wirkung
| Wert | Inline-Skript | Event-Handler | Inline-Modul | externes Skript (same-origin) | cross-origin Import | eval/Function | Wasm kompilieren | Blob/Data-Worker | Same-origin-Worker |
|---|---|---|---|---|---|---|---|---|---|
| keiner | läuft | läuft | läuft | läuft | läuft | läuft | läuft | läuft | läuft |
| `script-src * data: blob:` (**strict**) | blockiert | blockiert | blockiert | läuft | läuft | blockiert | blockiert | läuft | läuft |
| `script-src 'self'` | blockiert | blockiert | blockiert | läuft | blockiert | blockiert | blockiert | blockiert | läuft |
| `script-src 'self'; worker-src 'none'` | – | – | – | läuft | blockiert | blockiert | blockiert | blockiert | **blockiert** |
| `script-src 'self' 'wasm-unsafe-eval'` | – | – | – | läuft | blockiert | blockiert | **erlaubt** | blockiert | läuft |
| `script-src 'none'; worker-src 'none'; object-src 'none'` (**lockdown**) | blockiert | blockiert | blockiert | blockiert | n. a. | n. a. | n. a. | n. a. | blockiert |
| `sandbox allow-same-origin allow-forms` (nicht verwendet) | blockiert | blockiert | blockiert | blockiert | – | – | – | – | – |

Weitere Fakten:
- Dynamisch eingefügte Inline-`<script>`-Elemente sind bei strict blockiert, dynamisch eingefügte **externe** Skripte laufen (Netzwerkkontrolle ist Aufgabe des Moduls `scripts`).
- `<noscript>`-Inhalt wird bei CSP `script-src 'none'` **nicht** gerendert; mit `sandbox` (ohne `allow-scripts`) schon. AnoFox nutzt `sandbox` bewusst nicht (verändert Origin-/Popup-/Download-Verhalten, würde `allow-*`-Pflege erfordern).
- Die CSP-Regeln gelten nur für http(s)-Dokumente. Nicht abgedeckt: `about:`/`moz-extension:`/PDF-Viewer/Reader-Ansicht, `data:`/`blob:`-Dokumente (erben die Policy des Erstellers), Antworten, die ein Service Worker synthetisiert (nicht getestet), bfcache-Wiederherstellung (nicht getestet).

## Umsetzung in AnoFox
- Neues Modul `inline` („Inline-Skripte & Eval“): Profile balanced/strict = aus, lockdown = lockdown; als Custom einzeln wählbar (strict = kein Inline/eval, lockdown = gar kein JavaScript).
- `src/protection/network/compile.ts`: `compileInline` erzeugt höchstens zwei CSP-Regeln (Basis + Site-Blocks), nie `set`, nie `allow`.
- Rangfolge für Dokument-Host: Site-Regel (Block vor Allow) vor globaler Regel vor Profil. Per Test belegt (Unit + Firefox).
- Ausnahmen gelten für die **Dokument-Domain** (`requestDomains`), nicht für die Top-Level-Seite eines iFrames. Nicht erzwingbar und als `unsupported` gemeldet: Ziel-Domain, Container, Einmal- und Tab-Dauer. `session` entspricht „bis Browserende“ (Regeln werden beim Sitzungsstart entfernt).
- Popup „Skripte hier erlauben“ legt bei aktivem Inline-Schutz zusätzlich die zugehörige Inline-Ausnahme an (nur Sitzung/dauerhaft) und entfernt beide gemeinsam.

## Worker, Wasm, eval – Durchsetzbarkeit (getestet unter strict/`'self'`)
| Mechanismus | Durchsetzbar? |
|---|---|
| eval, `new Function` | ja (CSP, ohne `unsafe-eval`) |
| WebAssembly | ja, solange `'wasm-unsafe-eval'` fehlt (strict und lockdown blockieren Wasm) |
| Dedicated Worker (Blob/Data) | ja bei `script-src 'self'`; bei strict erlaubt (Absicht) |
| Dedicated Worker (same-origin) | nur über `worker-src 'none'` / lockdown |
| Shared Worker, Service Worker, Worklets | **nicht gesondert getestet**; fallen auf `worker-src`/`script-src` zurück, Verhalten bestehender Service-Worker-Registrierungen offen |
| Dynamic `import()` | same-origin läuft, cross-origin nur bei strict/offen |

## Offen
- Echter Test mit der **gebauten AnoFox-Erweiterung** (Harness T-1 mit Test-Treiber), inklusive `scripts`-Modul-Regeln und Listen.
- Service-Worker-Antworten, bfcache, Reader-Ansicht, Mindestversion unter 158.
- Script Inspector (4.4), Freigabe „einmal“ (nicht per DNR möglich), Wasm-Ausnahmeoption.
