# ADR-002 — Garmin G2 credential handling & token persistence

**Status:** accepted (2026-09-15)
**Context:** Phase G, Garmin integration via `python-garminconnect` sidecar (G2 only)

## Decision

Linus provides Garmin credentials as **env variables** for first login. The sidecar performs
the 2FA handshake **once**, then persists the resulting session token. From that point on the
**refresh token is the only credential that matters** and it must be stored durably.

**The refresh token must never be lost.** This is the explicit requirement — see "Why this ADR
exists" below.

## Why this ADR exists

Linus' direct words:

> "Zu G2, kann ich dir das Passwort auch als env variable geben, sonst passt es für mich als
> refresh Token, den darfst du nur nicht verlieren und musst ihn gut abspeichern. Aktuell
> verlierst du so etwas oft."

Translation of the requirement into engineering terms: the acceptance criterion for Phase G is
**not** "the sidecar can log in". It is **"the sidecar can recover from total loss of its
container and local volume without a new Garmin login."**

A credential that only exists inside a container filesystem is already lost — it survives `docker
restart` and dies on `docker compose down -v`, image rebuild, or host disk failure. The
requirement therefore forces three independent copies on three different failure domains:

| Copy | Location | Failure domain survived |
|---|---|---|
| Live working copy | host dir, `0600`, root-owned | container recreate, rebuild |
| Encrypted backup | Storage-Box (`/mnt/storagebox/`) | host disk loss |
| Encrypted offsite | restic repo (daily) | Storage-Box loss, host loss |

**Three copies, three domains, none of them inside the container.** That is the whole design.

## Credential lifecycle

### Stage 1 — Bootstrap (once)

Credentials arrive as env vars in `/opt/opengym-hybrid-garmin/.env` (`0600`, root):

```
GARMIN_EMAIL=...
GARMIN_PASSWORD=...
```

The sidecar's first run performs login + 2FA. **2FA requires a human** (code delivery to Linus).
This is a one-time interactive step, not a cron concern.

**Hard rule:** env vars are bootstrap-only. The sidecar must not read them on every start — if it
does, then a lost token silently re-derives from the password and nobody learns that the token
store failed. A token loss must be *loud*.

### Stage 2 — Token capture

`python-garminconnect`'s `Garmin.login()` yields a session with `di_refresh_token` /
`di_oauth1_token` / `di_oauth2_token`. The sidecar writes the session to:

```
/opt/opengym-hybrid-garmin/tokens/garmin-session.json     (host bind mount)
```

**The token directory is bind-mounted from the host, not a docker named volume.** Named volumes
are invisible to normal backup tooling and get orphaned by `docker compose down -v`. A host path
is inspectable, backable, and diffable. Permissions `0600`, root, dir `0700`.

### Stage 3 — Steady state

Subsequent starts load the token file and call the refresh path. Env password is **ignored** if a
valid token exists. If refresh fails:

1. **Retry with backoff** (3 attempts, 5/15/45 s) — transient Garmin API/network faults are common
   and must not trigger a credential reset.
2. On final failure: **do not fall back to password login automatically.** Write a distinct
   sentinel state and notify Linus via the error path. Auto-fallback to password would mask a real
   persistence failure, and would also mean the sidecar needs the password forever — which
   defeats the point of the refresh token.

### Stage 4 — Rotation

`python-garminconnect` rotates refresh tokens. Every successful refresh **rewrites the token file
atomically** (write temp in same dir → `os.replace()`), so a crash mid-write cannot truncate the
only copy. This is the single most likely way to lose the token, and it is a solved problem.

## Backup integration

A dedicated push into the existing backup chain, because the generic `tar czf … data/` pattern
does **not** cover this directory:

| When | What |
|---|---|
| After every successful token write | Copy to `/mnt/storagebox/garmin/garmin-session.json.enc` |
| Daily (existing restic job) | restic picks up the Storage-Box copy |
| Every start, before use | Verify token file parses as JSON and has the expected keys |

**Verification-on-start is the important one.** A corrupt or truncated token must be detected
*before* the sidecar tries to use it, so the failure is attributed correctly (storage problem) and
not (API problem).

Encryption: `age` or `gpg` with a key stored in `infra/garmin/` (0600). The token grants full
access to Linus' Garmin account, so it does not go to the Storage-Box in plaintext.

**Deliberate departure from upstream's pattern:** upstream's compose comment says the credential
cache is a sibling of `data/` *specifically so a live refresh token does not end up in the
documented `data/` backup*. That reasoning is sound for upstream (a Codex token is disposable —
"sign the provider in again"). It is **wrong here**: Linus' Garmin token cannot be trivially
re-derived (it needs 2FA and a human). So this sidecar deliberately *backs the token up*, and
keeps it in its own stack with its own backup path rather than inside openGym's `data/`.

## Interaction with openGym

The sidecar is fully isolated — separate compose project, separate network, no shared volumes with
`opengym-hybrid` or `opengym`. It communicates over HTTP only. This satisfies the workspace
stability rule: a Garmin API breakage cannot impair the training app.

Data flow: sidecar polls Garmin → normalises activities to the `S.run` session shape → `POST`s to
openGym's API. openGym never calls Garmin. Credentials never enter openGym's `data/`, so the
existing `tar czf … data/` backup stays credential-free.

## Acceptance criteria (Phase G is not done until all hold)

1. `docker compose down -v && docker compose up -d` → sidecar recovers **without** a new Garmin
   login.
2. Delete the token file → sidecar fails **loudly**, does not silently fall back to password.
3. Kill the sidecar mid-refresh (SIGKILL during the write window) → token file is still valid,
   because writes are atomic.
4. Corrupt the token file → detected on start, reported as a storage fault.
5. `grep -r` the openGym `data/` directory for the token → **zero hits**.
6. Storage-Box copy exists and differs from the live copy only by encryption.

## Consequences

**Good:** survives container loss, host disk loss, and Storage-Box loss independently. Token
failure is diagnosable. Credentials never touch the app or its backup.

**Cost:** one extra interactive step (2FA bootstrap), an extra encryption key to manage in
`infra/garmin/`, and a small sync script. Acceptable — the alternative is a recurring manual
re-login, which is the failure mode Linus explicitly called out.

**Risk accepted:** `python-garminconnect` is an unofficial API and may break. Mitigation: the
sidecar is isolated, so breakage is contained; a broken sidecar stops syncing but does not affect
training data.
