# Phase 0 — Status & Exit-Check

**Datum:** 2026-09-14 · **Status:** ✅ ABGESCHLOSSEN

## Was getan wurde

| # | Meilenstein | Status | Nachweis |
|---|---|---|---|
| M0.1 | Upstream `a68a88d` als Test-Instanz `/opt/opengym-hybrid` | ✅ | Container `opengym-hybrid-{api,web,media}-1` laufen, `ghcr.io/duartesantos8/opengym-*:latest` |
| M0.2 | Traefik-Router + Cloudflare A-Record | ✅ | `hybrid.gym.cabbagebaggage.net` A→187.124.178.155 (proxied=false, id `1e3be8b49fdc456cd0a837c2bd739d1a`) |
| M0.3 | Coach via `compatible`-Provider → Ollama | ✅ | `coach.json` (provider=compatible, baseUrl `http://ollama:11434/v1`, Modell `deepseek-v4-flash:cloud`) |
| M0.4 | Datenübernahme | ✅ | `db.json`, `state-0caVxDyhutN1sacQ.json` (170 KB), `secret`, `vapid.json` kopiert |
| M0.5 | ADR-001 | ✅ | `adr/ADR-001-patch-layer-not-fork.md` |

## Exit-Kriterien (alle erfüllt)

- `https://hybrid.gym.cabbagebaggage.net` → **HTTP 200** (TLS gültig) ✅
- `https://hybrid.gym.cabbagebaggage.net/api/health` → `{"ok":true,"users":1}` ✅
- Ollama vom API-Container erreichbar → `http://ollama:11434/api/tags` = OK ✅
- Prod `gym.cabbagebaggage.net` → **HTTP 200**, unverändert ✅

## Wichtige Betriebs-Notizen

1. **Compose-Projektname:** `opengym-hybrid` (via `docker-compose.override.yml` `name:` + `docker compose -p opengym-hybrid`). Ohne das kollidiert der Projektname `opengym` mit Prod.
2. **Port:** Web auf `8091:80` (Prod nutzt 8080). Traefik routet nur über Label `Host(hybrid.gym...)`.
3. **Traefik-Fallstrick:** Nach dem ersten `up` war der Router noch nicht registriert → `docker restart traefik-traefik-1` erzwang Rediscovery. Merken für künftige Dienste.
4. **Upstream-Coach ist HTTP-Provider:** kein Build, kein Adapter. Ollama = eine Config-Zeile.
5. **`secret` muss übereinstimmen:** Der Hybrid-Deploy hat `secret` von Prod kopiert → Passkeys/WebAuthn-`RP_ID` unterscheidet sich zwar (`hybrid.gym...`), aber die Passkey-DB ist dieselbe Kopie. Beim echten Test-Login ggf. neuer Passkey nötig (RP_ID ist Teil der WebAuthn-Bindung).

## Offen für nächste Runde

- [ ] Garmin G1 (Import-Parser) — Spec in `research/garmin-feasibility.md`
- [ ] Phase 1 (Domänenmodell `S.run`) — Spec in `spec/PLAN.md`
- [ ] 30-min-Schwellenpace als Kalibrierungs-Workout eintragen
