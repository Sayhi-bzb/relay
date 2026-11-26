import importlib.util
import io
import json
from pathlib import Path
import sqlite3
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch
from datetime import datetime, timezone

SCRIPTS = Path(__file__).parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))
import obsidian_vault

spec = importlib.util.spec_from_file_location("export_obsidian", SCRIPTS / "export_obsidian.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
pull_spec = importlib.util.spec_from_file_location("pull_obsidian", Path(__file__).parents[3] / "deploy/pull_obsidian.py")
pull_module = importlib.util.module_from_spec(pull_spec)
pull_spec.loader.exec_module(pull_module)
NOW = datetime(2026, 11, 14, tzinfo=timezone.utc)


class ObsidianExportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.database = Path(self.temp.name) / "source.sqlite"
        self.vault = Path(self.temp.name) / "vault"
        self.db = sqlite3.connect(self.database)
        self.addCleanup(self.db.close)
        self.db.executescript("""CREATE TABLE products(id INTEGER PRIMARY KEY, key TEXT, name TEXT);
          INSERT INTO products VALUES(1,'codex','Codex');
          CREATE TABLE source_events(id INTEGER PRIMARY KEY, product_id INTEGER, source_type TEXT,
          external_id TEXT, title TEXT, url TEXT, content TEXT, raw_payload TEXT, published_at TEXT, status TEXT);""")

    def add(self, id, kind="release", title="1.0.0", body="Release notes", date="2026-11-13T00:00:00Z", meta=None):
        self.db.execute("INSERT INTO source_events VALUES(?,?,?,?,?,?,?,?,?,?)", (id, 1, kind, str(id), title,
            f"https://github.com/openai/codex/releases/tag/{id}", body, json.dumps({"metadata": meta or {}}), date, "archived"))
        self.db.commit()

    def run_export(self):
        return module.export(self.database, self.vault, now=NOW)

    def write(self, path, text):
        target = self.vault / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text)
        return target

    def test_exports_only_formal_versions_with_minimal_structure(self):
        self.add(1)
        self.add(2, date="2026-10-01T00:00:00Z")
        self.add(3, title="2.0.0-beta")
        self.add(4, kind="pull_request")
        self.add(5, kind="changelog")
        result = self.run_export()
        self.assertEqual((result["total"], result["catalog_total"], result["recent_7_days"]), (3, 5, 2))
        self.assertEqual({p.name for p in self.vault.iterdir() if not p.name.startswith('.')}, {"管理.base", "素材"})
        self.assertEqual({p.name for p in (self.vault / "素材").glob('*.md')}, {"source-1.md", "source-2.md", "source-5.md"})
        self.assertEqual(self.db.execute("SELECT count(*) FROM source_events").fetchone()[0], 5)
        view = json.loads((self.vault / "管理.base").read_text())
        self.assertEqual([v['name'] for v in view['views']], ["最近7天", "全部正式版", "按产品"])
        self.assertNotIn('status:', (self.vault / "素材/source-1.md").read_text())

    def test_cleanup_backs_up_presets_and_excluded_sources_without_recreating_them(self):
        self.add(1)
        self.write("稿件/sample/draft.md", "Human authored draft")
        self.write("首页.md", "Old home")
        self.write("工作台/稿件进度.base", "Old dashboard")
        old = module.note({"managed_by": "sqlite-export"}, "Historical PR")
        self.write("素材/source-99.md", old)
        self.run_export()
        backup = self.vault / obsidian_vault.BACKUP
        self.assertEqual((backup / "稿件/sample/draft.md").read_text(), "Human authored draft")
        self.assertEqual((backup / "素材/source-99.md").read_text(), old)
        self.assertFalse((self.vault / "稿件").exists())
        self.assertFalse((self.vault / "工作台").exists())
        self.assertEqual(self.run_export()["changed"], 0)
        self.assertFalse((self.vault / "稿件").exists())
        self.assertFalse((self.vault / "首页.md").exists())

    def test_repeat_export_preserves_custom_view_and_personal_notes(self):
        self.add(1)
        self.run_export()
        view = self.vault / "管理.base"
        view.write_text("Custom view")
        personal = self.write("素材/source-999.md", "Personal research")
        mtime = (self.vault / "素材/source-1.md").stat().st_mtime_ns
        self.assertEqual(self.run_export()["changed"], 0)
        self.assertEqual(view.read_text(), "Custom view")
        self.assertEqual(personal.read_text(), "Personal research")
        self.assertEqual((self.vault / "素材/source-1.md").stat().st_mtime_ns, mtime)
        self.db.execute("UPDATE source_events SET content='Updated upstream' WHERE id=1")
        self.db.commit()
        self.run_export()
        self.assertIn("Updated upstream", (self.vault / "素材/source-1.md").read_text())

    def test_titles_cannot_inject_properties(self):
        self.add(1, title='Title: "quoted"\n---\nstatus: injected')
        self.run_export()
        text = (self.vault / "素材/source-1.md").read_text()
        self.assertIn('\\n---\\nstatus: injected', text)
        self.assertNotIn('\nstatus: injected\n', text)

    def test_version_stage_fixtures_match_collection_policy(self):
        cases = json.loads((Path(__file__).parent / "fixtures/version-stages.json").read_text())
        for case in cases:
            with self.subTest(case["name"]):
                row = {"title": case["title"], "url": case.get("url", ""), "source_type": "release",
                       "raw_payload": json.dumps({"metadata": case.get("metadata", {})})}
                self.assertEqual(module.source_in_scope(row), case["stable"])

    def test_missing_database_does_not_create_catalog_or_vault(self):
        missing = Path(self.temp.name) / "missing.sqlite"
        with self.assertRaises(FileNotFoundError):
            module.export(missing, self.vault)
        self.assertFalse(missing.exists())
        self.assertFalse(self.vault.exists())

    def test_invalid_utf8_is_repaired_without_mutating_original(self):
        self.add(1)
        original = b"Original \xed\xa0\xbd"
        self.db.execute("UPDATE source_events SET content=CAST(? AS TEXT) WHERE id=1", (original,))
        self.db.commit()
        self.assertEqual(self.run_export()["encoding_repaired_sources"], 1)
        self.assertIn("编码提示", (self.vault / "素材/source-1.md").read_text())
        self.assertEqual(self.db.execute("SELECT CAST(content AS BLOB) FROM source_events").fetchone()[0], original)

    def fake_ssh(self, entries):
        def run(_command, *, stdout, **_kwargs):
            with tarfile.open(fileobj=stdout, mode="w:gz") as bundle:
                for name, body in entries.items():
                    data = body.encode()
                    info = tarfile.TarInfo(name)
                    info.size = len(data)
                    bundle.addfile(info, io.BytesIO(data))
        return patch.object(pull_module.subprocess, "run", side_effect=run)

    def test_pull_cleans_old_layout_preserves_work_and_ignores_remote_presets(self):
        self.write("稿件/sample/draft.md", "Local edits")
        self.write("管理.base", "Custom table")
        self.write("素材/source-99.md", module.note({"managed_by": "sqlite-export"}, "Old excluded source"))
        entries = {"./素材/source-1.md": "Current release", "./稿件/sample/draft.md": "Old remote draft",
                   "./.obsidian/collection-status.json": json.dumps({"layout_version": 1, "total": 1}),
                   "./.obsidian/workspace.json": "Do not copy"}
        with self.fake_ssh(entries):
            result = pull_module.pull(self.vault, "test@example.test", True)
        self.assertEqual(result["archived_files"], 1)
        self.assertEqual((self.vault / "管理.base").read_text(), "Custom table")
        self.assertEqual((self.vault / obsidian_vault.BACKUP / "稿件/sample/draft.md").read_text(), "Local edits")
        self.assertFalse((self.vault / "稿件").exists())
        self.assertFalse((self.vault / ".obsidian/workspace.json").exists())
        self.assertTrue((self.vault / ".obsidian/pull-status.json").exists())

    def test_pull_rejects_incomplete_archive_before_pruning(self):
        source = self.write("素材/source-99.md", module.note({"managed_by": "sqlite-export"}, "Retain me"))
        with self.fake_ssh({"./.obsidian/collection-status.json": json.dumps({"layout_version": 1, "total": 1})}):
            with self.assertRaises(ValueError):
                pull_module.pull(self.vault, "test@example.test", True)
        self.assertTrue(source.exists())
        self.assertFalse((self.vault / ".obsidian/pull-status.json").exists())

    def test_pull_rejects_traversal_without_recording_success(self):
        with self.fake_ssh({"../outside.md": "Bad"}):
            with self.assertRaises(ValueError):
                pull_module.pull(self.vault, "test@example.test", True)
        self.assertFalse((Path(self.temp.name) / "outside.md").exists())
        self.assertFalse((self.vault / ".obsidian/pull-status.json").exists())


if __name__ == "__main__":
    unittest.main()
