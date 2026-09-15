# ADR-003 — Test-Subdomain via Traefik File-Provider, Prod bleibt bei Docker-Labels

- **Status:** Accepted
- **Datum:** 2026-09-15
- **Kontext:** Hybrid-Testinstanz auf `hybrid.gym.cabbagebaggage.net`, Hostinger (srv1535179)

## Problem

Die Hybrid-Testinstanz gab nach jedem Rebuild **404** zurück. Der Container lief und
antwortete direkt auf Port 8091 mit HTTP 200 — **Traefik erzeugte aber keinen Router
`opengymhybrid`**.

Die Docker-Labels des Hybrid-Containers waren Zeile für Zeile identisch mit denen des
funktionierenden Prod-Containers (`opengym`, gleiche Struktur: `traefik.enable=true`,
`traefik.docker.network=ollama-xwy9_default`, dieselben Netzwerke
`ollama-xwy9_default` + eigenes Compose-Default, derselbe `certResolver`).

Mehrere `docker restart traefik-traefik-1` in korrekter Reihenfolge (Container up → Traefik
restart, und umgekehrt) haben den Router **nicht** erscheinen lassen. Traefik startete sauber,
der Docker-Provider lief, entdeckte aber ausschließlich `opengym` (Prod) und `finanzlabel` —
nie `opengymhybrid`. Bei jedem Recreate erschienen `Failed to inspect container <old-id>`
für die *alten* Container, aber kein `create`-Event für die neuen.

Ursache ist eine **Race zwischen Docker-Event-Stream und Traefik-Restart** beim Recreate:
der Provider verliert das `create`-Event des neuen Containers und erholt sich nicht durch
einen Restart, weil der Container dann bereits „alt" ist.

## Entscheidung

**Für die Hybrid-Test-Subdomain: Traefik File-Provider.**
Router `opengymhybrid` + `opengymhybrid-http` (Redirect) und Service `opengymhybrid-svc`
in `/docker/traefik/dynamic.yml`, gebacken auf `http://opengym-hybrid-web-1:80` (stabiler
Container-Alias im gemeinsamen Netz).

**Für Prod (`gym.cabbagebaggage.net`): Docker-Labels bleiben unverändert.**

## Begründung

- Der File-Provider ist **ereignisfrei**: Traefik liest die Datei und hot-reloaded bei
  Änderung. Es gibt kein `create`-Event, das verloren gehen kann — die gesamte Fehlerklasse
  entfällt.
- Der Fix wirkte **ohne Traefik-Restart** (HTTPS sofort 200, HTTP 301).
- Die Hybrid-Instanz ist **Test-Infrastruktur, kein Prod-Pfad**. Eine Abweichung vom
  Label-Muster kostet dort nichts und macht Rebuilds reproduzierbar.
- Prod anzufassen, um ein Test-Routing-Problem zu lösen, wäre ein unverhältnismäßiges Risiko
  für einen laufenden Dienst mit echten Daten (144 Workouts).

## Konsequenzen

**Positiv**
- Rebuild der Hybrid-Instanz ist jetzt gefahrlos wiederholbar; der Router überlebt jedes
  `docker compose up` ohne Traefik-Eingriff.
- Die bestehenden Datei-Einträge (`acta`, `authentik`-Middleware) blieben unverändert —
  die Datei wird additiv erweitert, nicht ersetzt.

**Negativ / zu beachten**
- **Zwei Routing-Muster im System.** Wer eine neue Subdomain anlegt, muss wissen, welches
  gilt. Regel: Prod + Bestand = Labels; Hybrid-Test = Datei.
- Der Service zeigt auf den **Container-Namen** `opengym-hybrid-web-1`. Ein Wechsel des
  Compose-Projektnamens bricht den Router → `dynamic.yml` mitziehen.
- Prod bleibt vom Race-Problem **potenziell betroffen**, falls der Prod-Container je ohne
  Label-Änderung neu erstellt wird. Nicht angefasst, weil nicht reproduziert — aber
  vermerkt. Bei einem künftigen Prod-Rebuild ist zu prüfen, ob der Router `opengym`
  erhalten bleibt.

## Verifikation

```
https://hybrid.gym.cabbagebaggage.net/       → 200 (Let's Encrypt, CN=hybrid.gym…)
http://hybrid.gym.cabbagebaggage.net/        → 301 → https
https://hybrid.gym.cabbagebaggage.net/api/health → 200
https://gym.cabbagebaggage.net/              → 200 (Prod, unangetastet)
```

Backup der Vorfassung: `/docker/traefik/dynamic.yml.bak-20260915-190212`
