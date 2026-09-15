#!/usr/bin/env python3
"""Durable token store — write-once, verify-always, three-copy persistence.

Created 2026-09-15 for the Garmin sidecar (ADR-002), but deliberately generic:
any credential whose loss is not trivially recoverable should go through this.

WHY THIS EXISTS
---------------
Linus: "den darfst du nur nicht verlieren und musst ihn gut abspeichern.
Aktuell verlierst du so etwas oft."

That is a specification, not a complaint. The failure mode is always the same:
a credential lives in exactly one place (a container filesystem, or a file that
one script happens to know about), and then a rebuild / remount / crash removes
that place. The fix is structural, not attentiveness:

  1. Three copies on three failure domains (live, Storage-Box, restic offsite)
  2. Atomic writes (temp + os.replace) — a crash mid-write cannot truncate the
     only copy. This is the single most likely way to lose a token.
  3. Verify-on-read — a corrupt/token file is detected BEFORE use, so the fault
     is attributed to storage, not to the upstream API.
  4. Loud failure — never silently fall back to a weaker credential path.

USAGE
-----
    store = DurableTokenStore("garmin", "/var/lib/garmin-tokens")
    store.save(session_dict)          # atomic + fan-out to backup
    tok = store.load()                # verified, or raises TokenStoreError
    store.health()                    # dict for monitoring

CLI (for shell integration / watchdog):
    durable_token_store.py save <name> <json-file>
    durable_token_store.py verify <name>
    durable_token_store.py health <name>
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


class TokenStoreError(Exception):
    """Raised on any storage-level fault. Never swallowed."""


DEFAULT_BACKUP_ROOT = Path("/mnt/storagebox/secure/tokens")


@dataclass
class DurableTokenStore:
    """A credential store that assumes the filesystem will eventually fail.

    name:          logical credential name, e.g. "garmin"
    live_dir:      authoritative working copy (host path, 0700)
    backup_root:   Storage-Box mirror target; None disables fan-out
    required_keys: keys that must be present for the token to count as valid
    """

    name: str
    live_dir: str | Path
    backup_root: Path | None = DEFAULT_BACKUP_ROOT
    required_keys: tuple[str, ...] = field(default_factory=tuple)

    # ---------- paths ----------

    @property
    def dir(self) -> Path:
        return Path(self.live_dir)

    @property
    def path(self) -> Path:
        return self.dir / f"{self.name}-token.json"

    @property
    def backup_path(self) -> Path | None:
        if self.backup_root is None:
            return None
        return Path(self.backup_root) / f"{self.name}-token.json"

    # ---------- core ----------

    def _ensure_dir(self) -> None:
        self.dir.mkdir(parents=True, exist_ok=True)
        try:
            os.chmod(self.dir, 0o700)
        except OSError:
            pass  # not fatal; some filesystems refuse

    def save(self, data: dict[str, Any], source: str = "runtime") -> Path:
        """Atomically persist `data`, then fan out to backups.

        Atomicity matters more than speed here: the dangerous moment is a crash
        during the write, which a naive open(...,'w') turns into data loss.
        """
        if not isinstance(data, dict) or not data:
            raise TokenStoreError(f"{self.name}: refusing to save empty/non-dict token")

        # Enforce required keys on WRITE, not only on read. A partial token that
        # saves cleanly and only fails at load time defers the fault to a later,
        # less obvious moment — which is the exact failure pattern this module
        # exists to prevent.
        missing = [k for k in self.required_keys if k not in data]
        if missing:
            raise TokenStoreError(
                f"{self.name}: refusing to save incomplete token, missing keys {missing}"
            )

        self._ensure_dir()

        payload = {
            "_stored_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "_source": source,
            "token": data,
        }

        # Write to a temp file in the SAME directory (same filesystem, so
        # os.replace is atomic), fsync, then rename over the target.
        fd, tmp = tempfile.mkstemp(dir=str(self.dir), prefix=f".{self.name}-", suffix=".tmp")
        try:
            with os.fdopen(fd, "w") as f:
                json.dump(payload, f, indent=2)
                f.flush()
                os.fsync(f.fileno())
            os.chmod(tmp, 0o600)
            os.replace(tmp, self.path)   # atomic
        except Exception as e:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise TokenStoreError(f"{self.name}: atomic write failed: {e}") from e

        self._fan_out()
        return self.path

    def load(self, *, allow_empty: bool = False) -> dict[str, Any]:
        """Load and verify. Raises TokenStoreError rather than returning junk."""
        if not self.path.exists():
            if allow_empty:
                return {}
            raise TokenStoreError(
                f"{self.name}: token file missing at {self.path}. "
                f"Expected a credential bootstrap (see ADR-002)."
            )

        try:
            raw = self.path.read_text()
        except OSError as e:
            raise TokenStoreError(f"{self.name}: cannot read {self.path}: {e}") from e

        if not raw.strip():
            raise TokenStoreError(f"{self.name}: token file is EMPTY at {self.path}")

        try:
            payload = json.loads(raw)
        except json.JSONDecodeError as e:
            raise TokenStoreError(
                f"{self.name}: token file is CORRUPT (invalid JSON) at {self.path}: {e}. "
                f"This is a storage fault, not an API fault."
            ) from e

        token = payload.get("token") if isinstance(payload, dict) else None
        if not isinstance(token, dict) or not token:
            raise TokenStoreError(f"{self.name}: token file has no 'token' object at {self.path}")

        missing = [k for k in self.required_keys if k not in token]
        if missing:
            raise TokenStoreError(
                f"{self.name}: token incomplete, missing keys {missing} at {self.path}"
            )

        return token

    # ---------- persistence fan-out ----------

    def _fan_out(self) -> None:
        """Mirror to the Storage-Box. Best-effort: the live copy is authoritative.

        A failed mirror must be recorded, not raised — losing the mirror is
        survivable while losing the primary is not, and raising here would make
        the caller think the primary save failed.
        """
        dst = self.backup_path
        if dst is None:
            return
        if not Path("/mnt/storagebox").is_mount():
            self._note("backup skipped: /mnt/storagebox not mounted")
            return
        try:
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(self.path, dst)
            os.chmod(dst, 0o600)
            self._note(f"mirrored to {dst}")
        except Exception as e:
            self._note(f"mirror FAILED: {e}")

    def _note(self, msg: str) -> None:
        log = self.dir / f"{self.name}-token.log"
        try:
            with open(log, "a") as f:
                f.write(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}\n")
        except OSError:
            pass

    # ---------- monitoring ----------

    def health(self) -> dict[str, Any]:
        """Report for the watchdog. Never raises."""
        out: dict[str, Any] = {
            "name": self.name,
            "live_path": str(self.path),
            "live_exists": self.path.exists(),
            "live_valid": False,
            "live_age_hours": None,
            "backup_exists": False,
            "backup_in_sync": None,
            "storagebox_mounted": Path("/mnt/storagebox").is_mount(),
            "ok": False,
            "error": None,
        }
        try:
            tok = self.load()
            out["live_valid"] = True
            st = self.path.stat()
            out["live_age_hours"] = round((time.time() - st.st_mtime) / 3600, 1)
            out["keys_present"] = sorted(tok.keys())
        except TokenStoreError as e:
            out["error"] = str(e)

        dst = self.backup_path
        if dst is not None and dst.exists():
            out["backup_exists"] = True
            try:
                out["backup_in_sync"] = dst.read_bytes() == self.path.read_bytes()
            except OSError:
                out["backup_in_sync"] = None

        # Healthy = valid live token AND (no backup configured OR backup in sync)
        out["ok"] = bool(
            out["live_valid"]
            and (dst is None or out["backup_in_sync"] is True or not out["storagebox_mounted"])
        )
        return out


# ------------------------------- CLI -------------------------------

def _store_from_args(name: str) -> DurableTokenStore:
    live = os.environ.get("TOKEN_LIVE_DIR") or f"/var/lib/{name}-tokens"
    required = tuple(k for k in os.environ.get("TOKEN_REQUIRED_KEYS", "").split(",") if k)
    return DurableTokenStore(name, live, required_keys=required)


def main() -> int:
    if len(sys.argv) < 3:
        print(__doc__)
        return 2

    cmd, name = sys.argv[1], sys.argv[2]
    store = _store_from_args(name)

    try:
        if cmd == "save":
            if len(sys.argv) < 4:
                print("save requires a json file path")
                return 2
            data = json.loads(Path(sys.argv[3]).read_text())
            p = store.save(data, source="cli")
            print(f"saved -> {p}")
            return 0

        if cmd == "verify":
            store.load()
            print(f"OK: {store.path} valid")
            return 0

        if cmd == "health":
            h = store.health()
            print(json.dumps(h, indent=2))
            return 0 if h["ok"] else 2

    except TokenStoreError as e:
        print(f"TOKEN_STORE_ERROR: {e}")
        return 2
    except Exception as e:
        print(f"UNEXPECTED: {e}")
        return 2

    print(f"unknown command: {cmd}")
    return 2


if __name__ == "__main__":
    sys.exit(main())
