# Sicherheit

AnoFox ist in früher Entwicklung (0.1.0, nicht veröffentlicht). Es gibt noch keine unterstützten Releases.

## Schwachstellen melden

Bitte **nicht** öffentlich in ein Issue schreiben. Sobald das Repository veröffentlicht ist, nutze den privaten Meldeweg
(„Report a vulnerability“ / Security Advisories). Bis dahin melde dich direkt bei den Projektbetreuern.
Hilfreich sind: betroffene Firefox-Version, minimale Schritte zum Nachstellen und die erwartete Wirkung.

## Sicherheitsrelevantes Design

- Keine Telemetrie, keine Cloud, keine Fernkonfiguration. Nachrichten von Seiten (Content-Skripte) werden im Hintergrund auf
  `sender` und Form geprüft; Einstellungen aus Import/Storage werden Feld für Feld validiert.
- Aus Filterlisten wird **nie Code ausgeführt** (keine Scriptlets, kein `redirect=`); Selektoren werden vor der Verwendung
  gegen CSS-Ausbruch geprüft; Downloads laufen nur von einer festen HTTPS-Allowlist ohne Cookies und Referrer.
- Bereinigungen löschen nur nach Richtlinie, nie bei offenem Tab der Website und nie für als persistent markierte Hosts.
- Cookie-Namen und -Werte werden nicht protokolliert.
