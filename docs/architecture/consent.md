# Phase 7: Cookie-Banner-Manager

## Ziel und Garantien
- **Zustimmung wird nie erteilt.** Es gibt keinen „akzeptieren“-Pfad: weder in den Adapterdaten noch im Content-Skript.
- Ablehnen geschieht nur über die **eigenen Ablehnen-Schaltflächen** des Dialogs. Selbst bei passendem Herstellerselektor wird ein Element **nicht geklickt, wenn sein Beschriftungstext nach Zustimmung klingt** (Schutz gegen wiederverwendete IDs). Einzige Ausnahme: die „Auswahl speichern“-Schaltfläche, nachdem **alle optionalen Zwecke abgewählt** wurden (Cookiebot).
- Neutrale Schaltflächen („Einstellungen“, „Anpassen“, „Mehr erfahren“) werden nie geklickt.
- Unbekannte Dialoge werden nur behandelt, wenn der Container **sowohl** eine Zustimmen- **als auch** eine eindeutige Ablehnen-Schaltfläche bietet (kleinster solcher Container).
- Passt nichts, passiert nichts.

## Modi (`consentMode`, Standard `auto`)
| Modus | Verhalten |
|---|---|
| manual | AnoFox fasst Banner nicht an |
| reject | Ablehnen / „nur Notwendige“ über die Adapter-Abläufe oder den generischen Erkenner; Erfolg gilt erst, wenn der Dialog verschwindet (3 s), sonst nächster Ablauf, sonst „failed“ (kein Fallback auf Ausblenden) |
| hide | Nur ausblenden, **kein Klick**, keine Einwilligung. Nicht ausgeblendet werden „Wände“: Dialog > 50 % des Viewports, Scroll-Sperre (`overflow:hidden` an `html`/`body`) oder ein Vollbild-Backdrop – damit keine erforderliche Interaktion verdeckt wird |
| auto | Folgt der Stufe des Moduls „Cookie-Banner“: off → manual, balanced/strict/lockdown → reject |

Das Ausschalten des Moduls schlägt jeden expliziten Modus. Pro Website lässt sich die Automatik mit einer Regel (Modul „Cookie-Banner“, Erlauben; dauerhaft/Sitzung/Tab) abschalten, im Popup mit „Banner-Automatik hier aus“.

## Adapter (`src/protection/consent/adapters.ts`, reine Daten)
OneTrust (2 Abläufe, inkl. Präferenzzentrum), Cookiebot (Decline oder Optionale abwählen + „Auswahl erlauben“), Usercentrics (offener Shadow-DOM), Klaro, Didomi (IAB TCF), Quantcast Choice (IAB TCF), generischer Erkenner (mehrsprachige Beschriftungen: EN, DE, FR, ES, IT, NL, PT, PL).

**Verifikationsstatus (ehrlich):** Die Selektoren folgen dem dokumentierten bzw. üblichen DOM der Anbieter und werden in der E2E-Suite gegen **nachgebaute Dialoge** geprüft (`test/firefox/e2e/server.mjs`, 10 Fixtures + Fallen). Sie sind **nicht** gegen die Live-Skripte der Anbieter geprüft; Anbieter ändern Markup, Websites passen es an. Das ist die größte Unsicherheit dieses Moduls. IAB TCF: AnoFox spricht die `__tcfapi` nicht an; TCF-basierte Dialoge werden über ihre Oberfläche (Didomi, Quantcast, generisch) abgelehnt.

## Grenzen
- Nur das Hauptdokument. Banner in **fremden iFrames** (z. B. Sourcepoint) und in **geschlossenen Shadow-Roots** sind nicht erreichbar.
- Synthetische Klicks (`element.click()`): Anbieter könnten untrusted Events ignorieren; nur gegen Fixtures belegt.
- Die Entscheidung („abgelehnt“) merkt sich der Anbieter in seinen Cookies. Bei Websites mit Richtlinie „ephemeral/session“ löscht der Cookie Vault diese Cookies, der Dialog erscheint dann erneut und wird erneut abgelehnt. Für vertrauenswürdige (persistente) Websites bleibt die Entscheidung erhalten.
- Das Ablehnen ersetzt keinen Tracking-Schutz: Netzwerk-/Skriptmodule gelten unabhängig vom Banner.
- Ablaufzeit: bis 20 s nach dem Laden, Beobachtung per MutationObserver und Intervall.

## Tests
- Unit (`test/consent-core.test.ts`): Beschriftungen in 9 Sprachen, Zustimmungs- und Neutral-Labels werden nie „reject“, Adapterdaten enthalten keinen Accept-Pfad, Modus-Logik.
- E2E (`npm run test:e2e`, Filter `E2E_FILTER=consent`): 21 Prüfungen mit der gebauten Erweiterung – alle Adapter, Präferenzzentrum, Cookiebot-Abwahl, Shadow-DOM, generischer Dialog, Wand wird abgelehnt aber im Hide-Modus nicht ausgeblendet, Leiste wird ausgeblendet, Fallen (nur Accept/Customize, gespoofte Reject-ID auf „Accept all“, Schaltflächen im Artikel), manual, Modul aus, Regel pro Website, Statistik, unbekannter Modus.
