# ADR-001 — openGym-Hybrid ist ein Patch-Layer auf Upstream, kein Fork

- **Status:** Accepted
- **Datum:** 2026-09-14
- **Kontext:** openGym (DuarteSantos8/openGym), Fork alexpcosta/opengym, Deployment Hostinger

## Kontext

Das bisherige Deployment nutzt den Fork `alexpcosta/opengym` (`678bf5b`, ~v1.2.3, Aug 2026).
Upstream `main` steht bei **v1.3.7 (`a68a88d`, 2026-09-12)** — **349 Commits voraus** — mit
Release-Kadenz alle zwei Wochen (v1.3.8 → v1.4.7).

Die geplante Erweiterung (hybrides Kraft+Lauf-Training, Runna-paritätiger Laufcoach) ist
substanziell (~15 neue Module, neue View, neue Prompt-Familie). Gleichzeitig ist die Anforderung
explizit: **„meine Version soll von allen Updates der Haupt-App profitieren"**.

Der Fork hat den Coach als CLI-Spawn-Adapter gebaut (`api/coach/adapters/ollama.js`). Upstream
hat den Coach inzwischen architektonisch anders und umfassender gelöst:
`api/coach/core/providers.js` mit `HTTP_PROVIDERS` (anthropic, openai, gemini, **compatible** =
jeder OpenAI-kompatible Endpoint, Key optional) sowie per-User-API-Keys, Coach-Chat mit Kontext,
Combine-Routines, Revisionen-Merge-Sync.

Damit ist der Ollama-Adapter des Forks **obsolet**: Ollama ist upstream eine
Provider-Konfigurationszeile (`baseUrl: http://ollama:11434/v1`), kein Adapter-Code.

## Entscheidung

**Upstream `DuarteSantos8/openGym@main` ist die Basis. Die Hybrid-Erweiterung wird als dünner,
rebase-fähiger Patch-Layer implementiert.**

Regeln, die daraus folgen:

1. **Additiv, nicht destruktiv.** Neue Dateien statt Modifikation bestehender. Wo eine Modifikation
   unvermeidbar ist (Registrierung im Router, Change-Type-Allowlist), wird sie mit
   `// HYBRID:`-Marker versehen und als separater Commit mit `hybrid:`-Prefix geführt.
2. **Eigener Namespace `S.run`.** Die Lauf-Domäne wird **nicht** in den bestehenden
   `cardio`-Modus geschrieben. `cardio` bleibt unangetastet.
3. **Kein Adapter-Code.** Ollama läuft über `compatible`-Provider. Der eigene Adapter wandert
   nach `archive/`.
4. **Wöchentlicher Rebase.** `git fetch upstream && git rebase upstream/main`, CI-Smoke-Test
   `git rebase upstream/main && npm test`.
5. **Konfiguration in `data/`, nicht im Code** — Provider-Wahl, Modell, Caps.

## Konsequenzen

**Positiv**
- Jedes Upstream-Release (v1.3.8 … v1.4.7, inkl. SQLite v1.4.0, Accounts v1.4.1, iOS v1.4.2)
  kommt ohne Merge-Hölle an.
- Kein Build-Aufwand: Upstream liefert `ghcr.io/duartesantos8/opengym-api:latest` + `-web:latest`.
- Weniger eigener Code = weniger Wartung, kleinere Angriffsfläche.
- Der `cardio`-Bestandspfad und alle Bestands-Läufe bleiben unberührt.

**Negativ / Aufwand**
- `S.run` muss durch die v1.4.0-SQLite-Migration mitgezogen werden (M5.1 Checkliste).
- Jede unvermeidbare Upstream-Dateiänderung braucht Disziplin (Marker + Rebase-Test).
- Der alte Fork-Deploy wird zur reinen Historie — einmaliger Umzug nötig.

## Alternativen (verworfen)

| Alternative | Warum verworfen |
|---|---|
| Fork weiterführen, 349 Commits selektiv cherry-picken | Divergenz wächst ~15 Commits/Woche; Cherry-Pick-Hölle; Ollama-Adapter bleibt Zombie |
| Neuer Hard-Fork von v1.3.7 | Widerspricht der Anforderung „von Updates profitieren"; Patch-Layer erreicht dasselbe billiger |
| `cardio`-Modus erweitern statt `S.run` | Berührt 20+ Call-Sites, jede Upstream-Änderung wird zum Konflikt |
| Eigene Hybrid-App daneben | Kein Sync, kein Coach, kein Fortschritt für Linus |

## Referenzen

- `spec/PLAN.md` §2 (Architektur), §3 Phase 0
- Upstream: `api/coach/core/providers.js` (`HTTP_PROVIDERS.compatible`), `docker-compose.yml`
- Fork-Altlast: `alexpcosta/opengym@678bf5b:api/coach/adapters/ollama.js` → `archive/`
