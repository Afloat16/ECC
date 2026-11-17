"""Registry updates from the shell observer share the CLI's advisory lock."""

import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

import pytest


SCRIPTS = Path(__file__).resolve().parent


def load_module(name, source):
    spec = importlib.util.spec_from_file_location(name, str(source))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.mark.skipif(sys.platform == "win32" or not shutil.which("bash"), reason="POSIX Bash/flock integration")
def test_shell_writer_waits_for_cli_registry_lock(tmp_path, monkeypatch):
    store = tmp_path / "store"
    store.mkdir()
    monkeypatch.setenv("CLV2_HOMUNCULUS_DIR", str(store))
    cli = load_module("instinct_cli_registry_lock_test", SCRIPTS / "instinct-cli.py")
    if not cli._HAS_FCNTL:
        pytest.skip("fcntl unavailable")
    cli._update_registry("existing", "Existing", "/existing", "")
    registry = store / "projects.json"
    project_dir = store / "projects" / "shell"
    env = dict(os.environ, CLV2_NO_PROJECT="1", CLV2_PYTHON_CMD=sys.executable)
    child = None
    try:
        with cli._registry_lock():
            before = registry.read_bytes()
            child = subprocess.Popen(
                ["bash", "-c", 'source "$1"; _CLV2_PROJECT_DIR="$2"; '
                 '_clv2_update_project_registry shell "Shell project" /shell ""',
                 "registry-lock-test", str(SCRIPTS / "detect-project.sh"), str(project_dir)],
                env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            )
            deadline = time.monotonic() + 5
            while not project_dir.is_dir() and child.poll() is None and time.monotonic() < deadline:
                time.sleep(0.01)
            assert project_dir.is_dir(), "shell writer never reached its registry update"
            with pytest.raises(subprocess.TimeoutExpired):
                child.wait(timeout=0.15)
            assert registry.read_bytes() == before
            # Simulate the CLI committing another entry inside its actual critical section.
            records = json.loads(before)
            records["cli"] = {"id": "cli", "name": "CLI project"}
            registry.write_text(json.dumps(records), encoding="utf-8")
        stdout, stderr = child.communicate(timeout=5)
        assert child.returncode == 0, (stdout, stderr)
        result = json.loads(registry.read_text(encoding="utf-8"))
        assert set(result) == {"existing", "cli", "shell"}
        assert result["shell"]["name"] == "Shell project"
        assert json.loads((project_dir / "project.json").read_text()) == result["shell"]
    finally:
        if child is not None and child.poll() is None:
            child.kill()
            child.communicate(timeout=5)


@pytest.fixture
def writer():
    return load_module("shell_project_registry_test", SCRIPTS / "lib" / "project-registry.py")


def update(writer, tmp_path, pid="shell"):
    registry = tmp_path / "store" / "projects.json"
    project = registry.parent / "projects" / pid
    writer.update_registry(str(registry), str(project), pid, "Project \u4e2d\u6587", "/project", "https://example.invalid/project.git")
    return registry, project


def test_update_preserves_other_entries_and_creation_time(writer, tmp_path):
    registry, project = update(writer, tmp_path)
    first = json.loads(registry.read_text())
    first["other"] = {"name": "Unrelated"}
    first["shell"]["created_at"] = "2020-01-01T00:00:00Z"
    registry.write_text(json.dumps(first), encoding="utf-8")
    update(writer, tmp_path)
    result = json.loads(registry.read_text())
    assert result["other"] == first["other"]
    assert result["shell"]["created_at"] == "2020-01-01T00:00:00Z"
    assert result["shell"]["name"] == "Project \u4e2d\u6587"
    assert json.loads((project / "project.json").read_text()) == result["shell"]
    assert not list(registry.parent.rglob("*.tmp.*"))


def test_update_recovers_invalid_json_like_the_existing_shell_writer(writer, tmp_path):
    registry, _ = update(writer, tmp_path)
    registry.write_text("{incomplete", encoding="utf-8")
    update(writer, tmp_path)
    assert set(json.loads(registry.read_text())) == {"shell"}


def test_atomic_write_failure_preserves_destination_and_removes_temporary_file(writer, tmp_path, monkeypatch):
    destination = tmp_path / "projects.json"
    destination.write_bytes(b'{"keep": true}\n')

    def fail_replace(source, target):
        assert Path(source).is_file()
        assert str(target) == str(destination)
        raise OSError("injected replace failure")

    monkeypatch.setattr(writer.os, "replace", fail_replace)
    with pytest.raises(OSError, match="injected replace failure"):
        writer.atomic_write_json(str(destination), {"lost": False})
    assert destination.read_bytes() == b'{"keep": true}\n'
    assert list(tmp_path.iterdir()) == [destination]


def test_lock_released_after_failed_write(writer, tmp_path, monkeypatch):
    if writer.fcntl is None:
        pytest.skip("fcntl unavailable")
    registry, _ = update(writer, tmp_path)

    def fail_write(*args):
        raise OSError("injected disk error")

    monkeypatch.setattr(writer, "atomic_write_json", fail_write)
    with pytest.raises(OSError, match="injected disk error"):
        update(writer, tmp_path)
    with open(str(registry.parent / ".projects.json.lock"), "a") as lock:
        writer.fcntl.flock(lock, writer.fcntl.LOCK_EX | writer.fcntl.LOCK_NB)
        writer.fcntl.flock(lock, writer.fcntl.LOCK_UN)


def test_update_still_works_without_fcntl(writer, tmp_path, monkeypatch):
    monkeypatch.setattr(writer, "fcntl", None)
    registry, project = update(writer, tmp_path)
    assert json.loads(registry.read_text())["shell"]["root"] == "/project"
    assert (project / "project.json").is_file()


def test_command_entrypoint_reads_shell_environment(writer, tmp_path, monkeypatch):
    registry = tmp_path / "projects.json"
    project = tmp_path / "projects" / "entry"
    for key, value in {
        "FILE": registry, "PDIR": project, "PID": "entry", "PNAME": "Entry",
        "PROOT": "/entry", "PREMOTE": "",
    }.items():
        monkeypatch.setenv("_CLV2_REG_" + key, str(value))
    writer.main()
    assert json.loads(registry.read_text())["entry"]["name"] == "Entry"
