"""Atomic shell-observer metadata writes using the instinct CLI registry lock."""

from contextlib import contextmanager
from datetime import datetime, timezone
import json
import os
import tempfile

try:
    import fcntl
except ImportError:
    fcntl = None


@contextmanager
def registry_lock(registry_path):
    lock_file = None
    try:
        if fcntl is not None:
            lock_path = os.path.join(os.path.dirname(registry_path), "." + os.path.basename(registry_path) + ".lock")
            lock_file = open(lock_path, "a", encoding="utf-8")
            fcntl.flock(lock_file, fcntl.LOCK_EX)
        yield
    finally:
        if lock_file is not None:
            fcntl.flock(lock_file, fcntl.LOCK_UN)
            lock_file.close()


def atomic_write_json(path, payload):
    fd, tmp_path = tempfile.mkstemp(
        prefix="." + os.path.basename(path) + ".tmp.",
        dir=os.path.dirname(path),
        text=True,
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(payload, stream, indent=2)
            stream.write("\n")
        os.replace(tmp_path, path)
    finally:
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)


def update_registry(registry_path, project_dir, pid, name, root, remote):
    os.makedirs(project_dir, exist_ok=True)
    os.makedirs(os.path.dirname(registry_path), exist_ok=True)
    with registry_lock(registry_path):
        try:
            with open(registry_path, encoding="utf-8") as stream:
                registry = json.load(stream)
        except (FileNotFoundError, json.JSONDecodeError):
            registry = {}

        now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        entry = registry.get(pid, {})
        metadata = {
            "id": pid, "name": name, "root": root, "remote": remote,
            "created_at": entry.get("created_at", now), "last_seen": now,
        }
        registry[pid] = metadata
        atomic_write_json(os.path.join(project_dir, "project.json"), metadata)
        atomic_write_json(registry_path, registry)


def main():
    update_registry(*(os.environ["_CLV2_REG_" + key]
                      for key in ("FILE", "PDIR", "PID", "PNAME", "PROOT", "PREMOTE")))


if __name__ == "__main__":
    main()
