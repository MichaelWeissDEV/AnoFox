# Phase 10: Oberfläche (Dashboard, Komponenten, Barrierefreiheit)

## Aufbau
- **Optionsseite als Dashboard:** Seitenleiste mit gruppierter Navigation (Überblick · Schutz · Daten & Browser · System), ein `<main>`, Skip-Link, genau ein `<h1>`, Deep-Links über `#tab-…`. Aktive Seite per `aria-current="page"`, nicht aktive Bereiche per `hidden`, jeder Bereich ist eine benannte `region`, `document.title` folgt dem Bereich. Unter 860 px klappt die Seitenleiste zu einer umbrechenden Navigation.
- **Übersicht:** aktives Profil, eine Karte je Modul mit **wahrheitsgemäßem** Status (aus/Stufe, „aktiv erzwungen“, „experimentell“, „nicht implementiert“), Hinweise nur aus echten Statusdaten (z. B. „Phishing-Listen nicht aktiviert“, „Native Einstellung nicht änderbar“), „Konfigurieren“ springt in den richtigen Bereich. Zähler nur, wenn die (RAM-)Statistik an ist.
- **Bereiche:** Profile & Module · Regeln & Ausnahmen · URL-Bereinigung · Social Embeds · Werbe-/Tracker-Listen · Phishing & Malware · Cookie-Banner · Cookies & Website-Daten · Fingerprinting (nativ) · Statistik · Konsole · Backup. Die großen Abschnitte, die vorher eine lange Seite bildeten, haben jetzt eigene Mount-Punkte; ein Re-Render **behält den Tastaturfokus** auf dem gleichen Element (`keepFocus`).
- **Popup:** Karten (Website · Profil · Ausnahmen · Schnellschalter), echte Checkboxen mit `role="switch"` statt unsichtbarer Eingaben, `aria-live`-Statuszeile.
- **Warnseite** (`blocked.html`) nutzt dasselbe Design.
- **Komponenten:** `src/ui/components/dom.ts` (`h`, `chip`, `notice`, `button`, `keepFocus`; Text immer per `textContent`, nie `innerHTML`) und CSS-Komponenten in `public/ui.css` (Karte, Raster, Chip, Hinweis, Switch, Buttons, Skip-Link, Toast als `aria-live`-Region).

## Design-Tokens
`src/ui/tokens.mjs` ist die einzige Quelle aller Farben (dunkel/hell). `build.mjs` setzt sie in `ui.css` ein; `test/ui-tokens.test.ts` prüft **jedes** Text-/Rand-/Fokus-Paar in beiden Themes gegen WCAG 2.2 AA (4,5:1 Text, 3:1 Komponentenränder und Fokus). Beim Einführen der Tokens fielen im hellen Theme Akzent (3,7:1), Warnfarben und Eingaberänder (1,1:1) durch; sie wurden angepasst.

## Barrierefreiheit: was geprüft wird (echtes Firefox-Rendering, `E2E_FILTER='^ui '`)
| Prüfung | Ergebnis |
|---|---|
| Landmarks (ein `main`, ein benanntes `nav`, ein `h1`), `lang="de"`, Skip-Link zuerst und funktionsfähig | ✅ |
| Navigation: `aria-current`, genau ein sichtbarer Bereich, Titel, Hash, benannte Regionen (13 Bereiche) | ✅ |
| **Jedes** sichtbare Bedienelement in **jedem** Bereich hat einen zugänglichen Namen | ✅ (fand 20 unbenannte Schalter/Felder in den alten Bereichen; behoben) |
| Überschriftenebenen springen nicht | ✅ |
| Textkontrast ≥ 4,5:1 (große Schrift 3:1) im **tatsächlichen Rendering**, alle Bereiche, dunkel und hell | ✅ |
| Kein horizontales Scrollen bei 360 px, einspaltiges Layout | ✅ (fand einen Fehler: `1fr` statt `minmax(0,1fr)` machte die Seite breiter) |
| Popup: benannte Controls, vier erreichbare Switches, Live-Region, Kontrast beider Themes | ✅ |
| Warnseite: Landmarks, benannte Controls, Kontrast, ungültiger Aufruf sperrt „Trotzdem öffnen“ | ✅ |
| Fokus bleibt nach Re-Render auf dem gleichen Button bzw. Select | ✅ |
| Stylesheet: Fokusring ≥ 3 px, `prefers-reduced-motion`, `forced-colors`, Mindestzielgröße 36 px | ✅ (statische Prüfung) |

## Nicht geprüft / Grenzen
- **Kein Test mit echten Screenreadern** (NVDA, VoiceOver, Orca). Geprüft wird die Zugänglichkeits-Struktur (Namen, Rollen, Landmarks), nicht die Bedienbarkeit mit Hilfstechnik.
- Kein automatisierter Tastatur-Durchlauf der Tab-Reihenfolge; Fokus-Sichtbarkeit nur statisch (CSS-Regel) geprüft.
- Zoom 200 %/400 %, Windows-Kontrastmodus (nur CSS-Unterstützung vorhanden), Rechts-nach-links und Sprachen außer Deutsch nicht getestet.
- Die älteren Bereiche (URL-Bereinigung, Social Embeds, Statistik, Konsole, Backup) nutzen noch ihr altes Markup/CSS, sind aber benannt, kontrastgeprüft und in die neue Navigation eingebettet; eine vollständige Umstellung auf die neuen Komponenten steht aus.
- Hinweis zur Testumgebung: Wird in headless Firefox `resistFingerprinting` umgeschaltet, während die Optionsseite als iFrame in der Treiberseite hängt, friert die Testumgebung ein. Mit der Seite im eigenen Tab (der reale Fall) tritt das nicht auf; der Test läuft deshalb dort.
