"""Minimal vault layout and reversible cleanup shared by export and pull."""
from __future__ import annotations

from datetime import datetime, timezone
import json
from pathlib import Path
import re
import tempfile
from uuid import uuid4

LEGACY_PRESETS = ("工作台", "稿件", "专题", "模板", "首页.md", "AGENTS.md")
BACKUP = ".obsidian/backups/minimal-v1"


def atomic_write(path: Path, data: bytes, *, create_only: bool = False) -> bool:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.is_symlink():
        raise ValueError(f"Refusing symlink destination: {path}")
    if path.exists() and (create_only or path.read_bytes() == data):
        return False
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as stream:
        temporary = Path(stream.name)
        stream.write(data)
    try:
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)
    return True


def archive(vault: Path, path: Path) -> str:
    destination = vault / BACKUP / path.relative_to(vault)
    if destination.exists():
        destination = destination.with_name(destination.name + "." + uuid4().hex[:8])
    destination.parent.mkdir(parents=True, exist_ok=True)
    path.rename(destination)
    return str(destination.relative_to(vault))


def minimize(vault: Path) -> list[str]:
    (vault / "素材").mkdir(parents=True, exist_ok=True)
    marker = vault / ".obsidian/minimal-layout.json"
    if marker.exists():
        return []
    moved = [archive(vault, vault / name) for name in LEGACY_PRESETS if (vault / name).exists()]
    atomic_write(marker, (json.dumps({"version": 1, "migrated_at": datetime.now(timezone.utc).isoformat(),
                                    "backups": moved}, ensure_ascii=False, indent=2) + "\n").encode())
    return moved


def prune_sources(vault: Path, expected: set[str]) -> int:
    moved = 0
    for path in (vault / "素材").glob("source-*.md"):
        if path.name in expected or path.is_symlink() or not path.is_file():
            continue
        header = path.read_text(encoding="utf-8").split("\n---\n", 1)[0]
        if re.search(r'(?m)^managed_by:\s*"?sqlite-export"?\s*$', header):
            archive(vault, path)
            moved += 1
    return moved


def management_base() -> str:
    order = ["formula.document", "note.product", "note.kind", "formula.published_time", "note.url"]
    sort = [{"property": "note.published_at", "direction": "DESC"}]
    value = {"filters": 'type == "source"', "formulas": {"document": "link(file.path, title)",
             "published_time": 'if(published_at, date(published_at).format("YYYY-MM-DD HH:mm"), "")'},
             "properties": {"formula.document": {"displayName": "标题"}, "note.product": {"displayName": "产品"},
                            "note.kind": {"displayName": "类型"}, "formula.published_time": {"displayName": "发布时间"},
                            "note.url": {"displayName": "原始链接"}},
             "views": [
                 {"type": "table", "name": "最近7天", "filters": {"and": ["published_at != null", 'date(published_at) >= now() - "7d"']},
                  "order": order, "sort": sort},
                 {"type": "table", "name": "全部正式版", "order": order, "sort": sort},
                 {"type": "table", "name": "按产品", "groupBy": {"property": "note.product", "direction": "ASC"},
                  "order": order, "sort": sort},
             ]}
    return json.dumps(value, ensure_ascii=False, indent=2) + "\n"


def initialize(vault: Path) -> None:
    minimize(vault)
    atomic_write(vault / "管理.base", management_base().encode(), create_only=True)
    atomic_write(vault / ".obsidian/core-plugins.json", (json.dumps([
        "file-explorer", "global-search", "switcher", "properties", "page-preview", "bases",
    ], indent=2) + "\n").encode(), create_only=True)
    atomic_write(vault / ".obsidian/app.json", (json.dumps({"alwaysUpdateLinks": True,
        "newLinkFormat": "absolute", "attachmentFolderPath": "附件"}, indent=2) + "\n").encode(), create_only=True)
