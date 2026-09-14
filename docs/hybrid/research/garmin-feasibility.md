# Garmin-Integration — Machbarkeits-Assessment

**Datum:** 2026-09-14 · **Projekt:** `projects/opengym-hybrid/`
**Entscheidung (Linus, 2026-09-14): ausschließlich G2 (`python-garminconnect`).**

## Kurzantwort

**Ja, machbar.** Gewählter Weg: **G2 — Auto-Sync via `python-garminconnect` als Sidecar-Container.**

| Stufe | Was | Aufwand | Risiko | Status |
|---|---|---|---|---|
| G1 | Manueller Import (`.fit`/`.tcx`/`.gpx` Upload) | ~1 Tag | Gering | ❌ verworfen (Linus) |
| **G2** | **Auto-Sync via `python-garminconnect` (Sidecar)** | ~2–3 Tage | Mittel | ✅ **gewählt** |
| G3 | Offizielle Garmin Health API | Wochen, Partnervertrag | Hoch | ❌ verworfen |

## Details

### G2 — Auto-Sync (inoffiziell, aber verbreitet) — GEWÄHLT
- **Tool:** `python-garminconnect` (inoffiziell, reverse-engineered). Login mit Garmin-Credentials, Token-Cache.
- **Architektur:** eigener Sidecar-Container (wie `media`-Service), pollt Garmin, schreibt in `S.run`.
- **Sicherheit:** Credentials **nie** in `data/` (Backup-Leak). Eigener Mount `./garmin-auth` (analog `./coach-auth`), verschlüsselt via App-Secret (wie `config.js` `encrypt()`).
- **Risiko:** inoffizielle API kann brechen; Garmin kann Logins drosseln (Rate-Limit / 2FA).

### Verworfen
- **G1 (Manueller `.fit`/`.tcx`-Import):** würde einen Upload-Endpoint + Parser im API-Container
  brauchen → Eingriff in Upstream-Code, widerspricht dem Patch-Layer-Prinzip. Zudem manuelle Arbeit
  bei jedem Lauf. Verworfen.
- **G3 (Offizielle Garmin Health API):** Garmin-Developer-Programm mit Partnerfreigabe — für eine
  Self-Hosted-App unrealistisch. Verworfen.

## Sicherheits-Hartregel
> Garmin-Credentials landen in einem eigenen Mount (`./garmin-auth`, 600, außerhalb `data/`),
> verschlüsselt mit dem App-`secret` — identisch zur `coach.json`-`auth`-Verschlüsselung.
> **Niemals** in `data/` (würde in jeden `tar czf data/`-Backup wandern).

## Umsetzung (Phase G, nach Phase 3)

| # | Meilenstein |
|---|---|
| G2.1 | Sidecar-Container `opengym-hybrid-garmin` (Python 3.12 + `garminconnect`) im selben Compose, Netz `ollama-xwy9_default`, ohne Traefik-Route (rein intern) |
| G2.2 | Auth via `garth`-Token-Cache nach `./garmin-auth/` (600). Credentials in `./garmin-auth/.env`, mit App-`secret` verschlüsselt |
| G2.3 | **2FA:** einmaliger interaktiver Erst-Login (`docker exec -it … python auth.py`) → Token-Cache persistiert; danach non-interaktiv per garth-Refresh |
| G2.4 | Poller (alle 30 min): `get_activities_by_date(start, today, 'running')` → Normalisierung auf `S.run.sessions[].done`, `actualKm`, `actualPaceSec`, `avgHR`, `maxHR`, `splits[]` |
| G2.5 | Matching geplant ↔ absolviert (Datum + Distanz-/Struktur-Heuristik, Konfidenz-Score); unmatched → Activity Inbox im UI |
| G2.6 | Write-Back via bestehende Sync-API — **`GET /api/data/rev` lesen und mit `rev` schreiben** (sonst LWW-Overwrite-Konflikt) |
| **Exit** | Der 30-min-Schwellenpace-Lauf erscheint automatisch als absolvierte Session mit Pace/HR/Splits; `run.compliance` rechnet daraus |

**Risiko:** reverse-engineered API — bricht bei Garmin-Änderungen. Mitigation: Version pinnen,
Health-Check im Poller, Fehler setzt `garmin_sync_failed`-Flag statt zu crashen.

## Abhängigkeit
G2 braucht `S.run` (Phase 1) und das Compliance-Aggregat (Phase 4). Wird daher **nach Phase 3**
gebaut, damit der Matching-Layer gegen ein stabiles Schema läuft.
