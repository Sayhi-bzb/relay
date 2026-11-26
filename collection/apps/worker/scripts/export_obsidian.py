"""Export stable release sources into a minimal Obsidian collection vault."""
from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import re
import sqlite3
from urllib.parse import unquote, urlsplit

from obsidian_vault import atomic_write, initialize, prune_sources

POLICY = json.loads((Path(__file__).resolve().parents[1] / "content-policy.json").read_text(encoding="utf-8"))
ALLOWED_KINDS = set(POLICY["allowedKinds"])


def note(properties: dict, body: str) -> str:
    return "---\n" + "\n".join(f"{key}: {json.dumps(value, ensure_ascii=False)}"
                               for key, value in properties.items()) + "\n---\n\n" + body.rstrip() + "\n"


def metadata(row: dict) -> dict:
    try:
        raw = json.loads(row["raw_payload"] or "{}")
        result = raw.get("metadata", raw.get("元数据", {}))
        result = json.loads(result) if isinstance(result, str) else result
        return result if isinstance(result, dict) else {}
    except (ValueError, TypeError, AttributeError):
        return {}


def is_prerelease(row: dict) -> bool:
    meta = metadata(row)
    if meta.get("prerelease") is True or meta.get("draft") is True:
        return True
    try:
        tag = unquote(urlsplit(row.get("url") or "").path.split("/releases/tag/", 1)[1])
    except (ValueError, IndexError):
        tag = ""
    values = [row.get("title"), tag, meta.get("tagName"), meta.get("tag_name"), meta.get("version"), meta.get("channel")]
    return any(isinstance(value, str) and re.search(POLICY["prereleasePattern"], value, re.I) for value in values)


def source_in_scope(row: dict) -> bool:
    return row["source_type"] in ALLOWED_KINDS and (POLICY["includePrereleases"] or not is_prerelease(row))


def published(row: dict) -> datetime | None:
    try:
        value = datetime.fromisoformat((row["published_at"] or "").replace("Z", "+00:00"))
        return value.replace(tzinfo=value.tzinfo or timezone.utc)
    except ValueError:
        return None


def export(database: Path, vault: Path, *, now: datetime | None = None) -> dict:
    if not database.is_file():
        raise FileNotFoundError(database)
    if database.resolve().is_relative_to(vault.resolve()):
        raise ValueError("SQLite must stay outside the vault")
    now = now or datetime.now(timezone.utc)
    connection = sqlite3.connect(database.resolve().as_uri() + "?mode=ro", uri=True, timeout=30)
    connection.row_factory = sqlite3.Row
    connection.text_factory = lambda data: data.decode("utf-8", errors="surrogateescape")
    try:
        rows = [dict(row) for row in connection.execute("""SELECT e.*, p.key AS product_key, p.name AS product_name
                  FROM source_events e JOIN products p ON p.id=e.product_id ORDER BY e.id""")]
    finally:
        connection.close()
    active = [row for row in rows if source_in_scope(row)]
    initialize(vault)
    changed = repaired = recent = 0
    expected = set()
    for row in active:
        encoding_repaired = False
        for key, value in row.items():
            if isinstance(value, str) and re.search(r"[\udc80-\udcff]", value):
                row[key] = value.encode("utf-8", errors="surrogateescape").decode("utf-8", errors="replace")
                encoding_repaired = True
        repaired += encoding_repaired
        stamp = published(row)
        recent += stamp is not None and now - timedelta(days=7) <= stamp <= now
        props = {"type": "source", "source_id": row["id"], "title": row["title"], "product": row["product_name"],
                 "category": POLICY["category"], "kind": row["source_type"], "published_at": row["published_at"],
                 "url": row["url"], "managed_by": "sqlite-export"}
        body = f"# {row['title'].replace(chr(10), ' ')}\n\n[原始来源](<{row['url']}>)\n\n" + (
            row["content"] or "当前记录没有正文，请打开原始来源。")
        if encoding_repaired:
            body += "\n\n> 编码提示：原始记录含非 UTF-8 字节，阅读副本用 � 替换；请回到来源核验。"
        name = f"source-{row['id']}.md"
        expected.add(name)
        changed += atomic_write(vault / "素材" / name, note(props, body).encode())
    archived = prune_sources(vault, expected)
    summary = {"layout_version": 1, "exported_at": now.isoformat(), "total": len(active), "catalog_total": len(rows),
               "recent_7_days": recent, "changed": changed, "archived_files": archived,
               "historical_total": len(rows) - len(active),
               "products": dict(Counter(row["product_name"] for row in active)),
               "encoding_repaired_sources": repaired}
    atomic_write(vault / ".obsidian/collection-status.json", (json.dumps(summary, ensure_ascii=False, indent=2) + "\n").encode())
    return summary


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", required=True, type=Path)
    parser.add_argument("--vault", required=True, type=Path)
    args = parser.parse_args()
    print(json.dumps(export(args.database, args.vault), ensure_ascii=False))
