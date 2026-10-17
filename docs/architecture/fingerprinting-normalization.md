# Phase 5.3: Normalisierung von UA, Sprache, Plattform, Hardware – Machbarkeit und Entscheidung

**Entscheidung: JS-seitige Normalisierung dieser Werte wird in AnoFox derzeit NICHT ausgeliefert.** Sie wäre technisch möglich, würde aber nachweislich eine zusätzliche, leicht erkennbare Inkonsistenz erzeugen und damit die Wiedererkennbarkeit verschlechtern statt verbessern. Das entspricht der Vorgabe: Verfahren ohne Nachweis, dass sie die Wiedererkennbarkeit nicht verschlechtern, bleiben aus.

Belegt durch `npm run test:firefox:navigator` (headless **Firefox 158.0**, Probe-Erweiterung, Erkennungsseite `test/firefox/navigator/server.mjs`; Testwerte: `hardwareConcurrency=4`, UA „Linux/Firefox 128“, Plattform `Linux x86_64`, Sprache `en-US`).

## Geprüfte Techniken
| Technik | Beschreibung |
|---|---|
| A MAIN-Getter | `scripting.registerContentScripts({ world: "MAIN", runAt: "document_start", allFrames: true, matchOriginAsFallback: true })`, Getter auf `Navigator.prototype` ersetzt |
| B MAIN + `toString`-Patch | wie A, zusätzlich `Function.prototype.toString` manipuliert, Getter mit nativem Namen |
| C ISOLATED + Xray | Content Script (ISOLATED) mit `exportFunction` / `wrappedJSObject` |

(`matchAboutBlank` wird von `scripting.registerContentScripts` in Firefox 158 nicht akzeptiert; `matchOriginAsFallback` schon.)

## Ergebnisse
**Machbar:**
- Alle drei laufen **vor** dem ersten Inline-Skript der Seite (`early.hw = 4`) und decken `about:blank`- sowie `srcdoc`-iFrames ab. Keine zusätzlichen `window`-Globals (Probe: nur das Testartefakt `__earlyHw`).

**Nicht lösbar bzw. erkennbar:**
1. **Dedicated Worker (Blob und Datei) bleiben unverändert** (`hardwareConcurrency 16`, echter UA, echte Sprachen, echte Plattform), während die Seite die Spoof-Werte meldet. Ein Vergleich Seite ↔ Worker deckt die Manipulation sofort auf; Shared- und Service-Worker sind ebenso wenig erreichbar. Ein Wrapper um `new Worker` wäre selbst erkennbar, löst Service/Shared Worker nicht und kollidiert mit CSP/Modul-Workern.
2. **HTTP-Header widersprechen dem JS:** `User-Agent` und `Accept-Language` der Anfrage bleiben die echten Werte (`navigator.userAgent === Header` wird `false`). Per DNR `modifyHeaders` wären Header setzbar, die Worker-Lücke bliebe.
3. **Erkennbare API-Spuren:**
   - A: `getter.toString()` verrät den Quelltext, `name` ist `get` statt `get hardwareConcurrency`.
   - B: `toString`/`name` stimmen, aber ein Aufruf mit falschem Receiver wirft **keinen** `TypeError` mehr (nativ: `'get hardwareConcurrency' called on an object that does not implement interface Navigator`); zusätzlich ist `Function.prototype.toString` selbst verändert.
   - C: `name` ist leer, `toString` zeigt `function () { [native code] }` statt `function hardwareConcurrency() { [native code] }`, kein `TypeError` bei falschem Receiver.
4. **UA-vs-Feature-Konsistenz (5.4):** Ein UA „Firefox 128“ in einem 158er-Browser widerspricht verfügbaren APIs (Feature Detection); eine kleinere Häufigkeit der Kombination „Linux + Firefox 128 + 4 Kerne“ bei gleichzeitig macOS-typischen Fonts/Grafik ist zusätzlich auffällig.

Bekannte Fingerprinting-Skripte prüfen genau diese Widersprüche (Seite vs. Worker, Deskriptor-/Fehlerverhalten). Ein erkannter „Lügner“ ist ein stärkeres Merkmal als der echte, geteilte Wert.

## Was stattdessen gilt
- Native Reduktion über `resistFingerprinting` & Co. (Phase 5.1) ist konsistent (C++-Ebene, Worker eingeschlossen) und gemessen; sie ändert UA/Plattform/Sprache aber nicht.
- Diese Werte sind für Erweiterungen nicht konsistent änderbar. Wer sie trotzdem anpassen will, kann **auf eigene Verantwortung** Firefox-Einstellungen in `about:config` bzw. `user.js` verwenden (z. B. `privacy.spoof_english`, `privacy.fingerprintingProtection`, `privacy.resistFingerprinting.letterboxing`). Das ist **nicht** von AnoFox gesetzt oder geprüft.
- `hardwareConcurrency`, UA, Plattform, Sprache bleiben im Fingerprint-Modul als „nicht implementiert“ gekennzeichnet.

## Wann neu bewerten
Der Test schlägt absichtlich fehl, wenn sich eines dieser Fakten in einer neuen Firefox-Version ändert (z. B. Worker-Abdeckung für Erweiterungen, native Getter-Nachbildung). Voraussetzungen für einen Neuanlauf: (1) Worker-Parität belegt, (2) Header- und JS-Werte aus einer Quelle, (3) keine zusätzlichen Erkennungsmerkmale in der Erkennungsseite, (4) Wirkung auf einer gemeinsamen, häufigen Zielpopulation statt Zufallswerten.
