import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('sync_source', Path(__file__).parents[1] / 'scripts/sync-source.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class SourceImportTest(unittest.TestCase):
    def test_only_source_article_is_imported_with_structure_and_links(self):
        raw = '<nav>Navigation</nav><article id="mainContent"><h2 id="skills">Skills</h2><p>Use <code>AGENTS.md</code> &amp; 中文.</p><blockquote>Example</blockquote><a href="/skills/">Guide</a></article><aside>Related posts</aside>'
        result = module.extract_article(raw, 'https://developers.openai.com/blog/example')
        self.assertIn('<h2 id="skills">Skills</h2>', result)
        self.assertIn('<code>AGENTS.md</code> &amp; 中文.', result)
        self.assertIn('<blockquote>Example</blockquote>', result)
        self.assertIn('href="https://developers.openai.com/skills/"', result)
        self.assertNotIn('Navigation', result)
        self.assertNotIn('Related posts', result)

    def test_executable_markup_and_attributes_are_not_published(self):
        raw = '<article id="mainContent"><script>bad()</script><button>Copy</button><p onclick="bad()">Original</p><a href="jav&#x61;script:bad()">Link</a><img src="data:text/html,bad" onerror="bad()"><h2 id="safe" style="color:red">Heading</h2></article>'
        result = module.extract_article(raw, 'https://example.com/article')
        self.assertNotIn('bad()', result)
        self.assertNotIn('onclick', result)
        self.assertNotIn('onerror', result)
        self.assertNotIn('javascript:', result)
        self.assertNotIn('style=', result)
        self.assertNotIn('Copy', result)
        self.assertIn('<p>Original</p>', result)
        self.assertIn('<h2 id="safe">Heading</h2>', result)

    def test_missing_ambiguous_or_incomplete_capture_is_rejected(self):
        for raw in ['<main>No article</main>', '<article id="mainContent"><p>Incomplete</p>', '<article id="mainContent"><p>One</p></article><article id="mainContent"><p>Two</p></article>']:
            with self.subTest(raw=raw):
                with self.assertRaises(ValueError):
                    module.extract_article(raw, 'https://example.com/article')

    def test_figure_imports_photo_caption_alt_and_dimensions(self):
        raw = '<article id="mainContent"><figure><a href="/full.webp"><img src="/house.webp" alt="A [house]" width="1200" height="800"></a><figcaption>The "original" scene.</figcaption></figure><img alt="No source"></article>'
        markdown, sizes = module.render_article(module.extract_article(raw, 'https://example.com/article'))
        self.assertEqual(markdown, r'![A \[house\]](<https://example.com/house.webp> "The \"original\" scene.")' + '\n')
        self.assertEqual(sizes, {'https://example.com/house.webp': {'width': 1200, 'height': 800}})

    def test_real_capture_and_provenance_are_preserved_and_sync_is_idempotent(self):
        with tempfile.TemporaryDirectory() as directory:
            output = module.sync_source(destination=Path(directory))
            document = output.read_text()
            frontmatter, body = document.split('---\n', 2)[1:]
            data = {key: json.loads(value.strip()) for key, value in (line.split(':', 1) for line in frontmatter.splitlines())}
            self.assertEqual(data['publisher'], 'Relay Demo')
            self.assertEqual(data['author'], 'Relay Demo')
            self.assertEqual(data['published_at'], '2026-01-01')
            self.assertEqual(data['retrieved_at'], '2026-01-01')
            self.assertEqual(sum(line.startswith('## ') for line in body.splitlines()), 4)
            self.assertNotIn('<p>', body)
            self.assertIn('> A saved draft stays available', body)
            self.assertIn('Example Release 1.0 lets a reader pin a note', body)
            self.assertIn('Choose a product, then open a release', body)
            self.assertIn('share the original source with a teammate', body)
            self.assertNotIn('header-search-title', body)
            self.assertNotIn('<!-- chunk:', body)
            self.assertNotIn('torph', body)
            before = output.stat().st_mtime_ns
            self.assertEqual(module.sync_source(destination=Path(directory)), output)
            self.assertEqual(output.read_text(), document)
            self.assertEqual(output.stat().st_mtime_ns, before)


if __name__ == '__main__':
    unittest.main()
