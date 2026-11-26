"""Pull the minimal collection vault from the VPS without recreating editorial presets."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import fcntl
import json
from pathlib import Path, PurePosixPath
import subprocess
import sys
import tarfile
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "apps/worker/scripts"))
from obsidian_vault import atomic_write, initialize, prune_sources


def pull(vault: Path, remote: str, bootstrap: bool) -> dict:
    vault = vault.resolve()
    vault.mkdir(parents=True, exist_ok=True)
    (vault / ".obsidian").mkdir(exist_ok=True)
    with (vault / ".obsidian/source-pull.lock").open("w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return {"skipped": "another pull is running"}
        command = "sudo -n tar -C /srv/ai-news-radar/obsidian-vault -czf - " + (
            "素材 管理.base .obsidian/collection-status.json .obsidian/app.json .obsidian/core-plugins.json"
            if bootstrap else "素材 .obsidian/collection-status.json")
        changed = initialized = 0
        expected = set()
        collection_status = None
        with tempfile.TemporaryFile() as archive:
            subprocess.run(["/usr/bin/ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15",
                            "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3", remote, command],
                           stdout=archive, stderr=subprocess.PIPE, timeout=240, check=True)
            archive.seek(0)
            with tarfile.open(fileobj=archive, mode="r:gz") as bundle:
                for member in bundle:
                    relative = PurePosixPath(member.name)
                    if relative.is_absolute() or ".." in relative.parts or member.issym() or member.islnk():
                        raise ValueError(f"Unsafe archive member: {member.name}")
                    if not member.isfile():
                        continue
                    path = vault.joinpath(*relative.parts)
                    if not path.resolve().is_relative_to(vault) or path.is_symlink():
                        raise ValueError(f"Unsafe destination: {path}")
                    source = len(relative.parts) == 2 and relative.parts[0] == "素材" and path.name.startswith("source-") and path.suffix == ".md"
                    if source:
                        expected.add(path.name)
                    generated = source or str(relative) == ".obsidian/collection-status.json"
                    permitted = generated or str(relative) in {"管理.base", ".obsidian/app.json", ".obsidian/core-plugins.json"}
                    if not permitted:
                        continue
                    if not generated and (not bootstrap or path.exists()):
                        continue
                    stream = bundle.extractfile(member)
                    if stream is None:
                        continue
                    data = stream.read()
                    if str(relative) == ".obsidian/collection-status.json":
                        collection_status = json.loads(data)
                    if atomic_write(path, data):
                        if generated:
                            changed += 1
                        else:
                            initialized += 1
        if not isinstance(collection_status, dict) or collection_status.get("layout_version") != 1 or collection_status.get("total") != len(expected):
            raise ValueError("Incomplete collection archive; existing sources were not pruned")
        initialize(vault)
        archived = prune_sources(vault, expected)
        count = len(expected)
        stamp = datetime.now(timezone.utc).isoformat()
        summary = {"pulled_at": stamp, "source_count": count, "changed": changed,
                   "initialized": initialized, "archived_files": archived}
        atomic_write(vault / ".obsidian/pull-status.json", (json.dumps(summary, ensure_ascii=False, indent=2) + "\n").encode())
        return summary


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--vault", type=Path, required=True)
    parser.add_argument("--remote", required=True)
    parser.add_argument("--bootstrap", action="store_true")
    args = parser.parse_args()
    try:
        print(json.dumps(pull(args.vault, args.remote, args.bootstrap), ensure_ascii=False))
    except subprocess.CalledProcessError as error:
        raise SystemExit(f"SSH pull failed: {error.stderr.decode(errors='replace')[-1000:]}") from error
