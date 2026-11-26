from html import escape
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urljoin, urlparse
import datetime
import json
import re

SITE = Path(__file__).resolve().parents[1]
CASES = SITE.parent / 'processing/cases'
CAPTURE = CASES / 'relay-demo'
VOID = {'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'}
ALLOWED = {'p', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'strong', 'b', 'em', 'i', 'a', 'code', 'pre', 'blockquote', 'hr', 'br', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'figure', 'figcaption', 'span', 'div', 'img'}
BLOCKED = {'script', 'style', 'iframe', 'object', 'embed', 'svg', 'button', 'form', 'input', 'nav', 'video', 'audio'}


class SourceArticle(HTMLParser):
    def __init__(self, url):
        super().__init__(convert_charrefs=True)
        self.url = url
        self.stack = []
        self.parts = []
        self.found = 0

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if not self.stack:
            if tag == 'article' and attrs.get('id') == 'mainContent':
                self.found += 1
                self.stack.append((tag, False, False))
            return
        blocked = self.stack[-1][2] or tag in BLOCKED
        output = not blocked and tag in ALLOWED
        if output:
            safe = {}
            if tag.startswith('h') and attrs.get('id'):
                safe['id'] = attrs['id']
            if tag == 'a' and attrs.get('href'):
                href = attrs['href'].strip()
                href = href if href.startswith('#') else urljoin(self.url, href)
                if href.startswith('#') or urlparse(href).scheme.lower() in {'http', 'https', 'mailto'}:
                    safe['href'] = href
            if tag == 'img':
                value = (attrs.get('src') or '').strip()
                src = urljoin(self.url, value)
                if value and urlparse(src).scheme.lower() in {'http', 'https'}:
                    safe.update(src=src, alt=attrs.get('alt', ''))
                    for dimension in ('width', 'height'):
                        if re.fullmatch(r'[1-9][0-9]{0,5}', attrs.get(dimension) or ''):
                            safe[dimension] = attrs[dimension]
                else:
                    output = False
            if output:
                attributes = ''.join(f' {key}="{escape(value, quote=True)}"' for key, value in safe.items())
                self.parts.append(f'<{tag}{attributes}>')
        if tag not in VOID:
            self.stack.append((tag, output, blocked))

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in VOID:
            self.handle_endtag(tag)

    def handle_endtag(self, tag):
        if not any(frame[0] == tag for frame in self.stack):
            return
        while self.stack:
            name, output, _ = self.stack.pop()
            if output:
                self.parts.append(f'</{name}>')
            if name == tag:
                break

    def handle_data(self, data):
        if self.stack and not self.stack[-1][2]:
            self.parts.append(escape(data, quote=False))

    def result(self):
        if self.found != 1 or self.stack or not ''.join(self.parts).strip():
            raise ValueError('Expected one complete, nonempty article#mainContent in the capture.')
        return ''.join(self.parts)


def extract_article(html, url):
    parser = SourceArticle(url)
    parser.feed(html)
    parser.close()
    return parser.result()


class MarkdownArticle(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = {'tag': 'root', 'attrs': {}, 'children': []}
        self.stack = [self.root]

    def handle_starttag(self, tag, attrs):
        node = {'tag': tag, 'attrs': dict(attrs), 'children': []}
        self.stack[-1]['children'].append(node)
        if tag not in VOID:
            self.stack.append(node)

    def handle_endtag(self, tag):
        for index in range(len(self.stack) - 1, 0, -1):
            if self.stack[index]['tag'] == tag:
                del self.stack[index:]
                break

    def handle_data(self, data):
        self.stack[-1]['children'].append(data)


def markdown_text(node):
    if isinstance(node, str):
        return node
    return ''.join(markdown_text(child) for child in node['children'])


def markdown_image(node, caption=''):
    attrs = node['attrs']
    alt = markdown_node(' '.join(attrs.get('alt', '').split()))
    src = attrs['src'].replace(' ', '%20').replace('<', '%3C').replace('>', '%3E')
    title = ' "' + caption.replace('\\', '\\\\').replace('"', '\\"') + '"' if caption else ''
    return f'![{alt}](<{src}>{title})'


def image_dimensions(node):
    if isinstance(node, str):
        return {}
    attrs = node['attrs']
    if node['tag'] == 'img' and all(key in attrs for key in ('src', 'width', 'height')):
        return {attrs['src']: {key: int(attrs[key]) for key in ('width', 'height')}}
    return {url: size for child in node['children'] for url, size in image_dimensions(child).items()}


def markdown_node(node):
    if isinstance(node, str):
        return re.sub(r'([\\`*_\[\]<>])', r'\\\1', node)
    tag = node['tag']
    if tag == 'img':
        return markdown_image(node)
    if tag == 'figure':
        parts = [child for child in node['children'] if not isinstance(child, str) or child.strip()]
        if len(parts) == 2 and all(isinstance(part, dict) for part in parts) and parts[1]['tag'] == 'figcaption':
            media = parts[0]
            image = media if media['tag'] == 'img' else None
            if media['tag'] == 'a':
                children = [child for child in media['children'] if not isinstance(child, str) or child.strip()]
                if len(children) == 1 and isinstance(children[0], dict) and children[0]['tag'] == 'img':
                    image = children[0]
            if image:
                caption = ' '.join(markdown_text(parts[1]).split())
                return markdown_image(image, caption) + '\n\n'
        return '\n\n'.join(markdown_node(part).strip() for part in parts).strip() + '\n\n'
    text = ''.join(markdown_node(child) for child in node['children'])
    if tag in {'root', 'div', 'figure', 'figcaption', 'p'}:
        return text.strip() + '\n\n'
    if tag in {'span'}:
        return text
    if tag in {'h2', 'h3', 'h4', 'h5', 'h6'}:
        return '#' * int(tag[1]) + ' ' + text.strip() + '\n\n'
    if tag == 'code':
        value = markdown_text(node)
        marker = '`' * max(1, 1 + max((len(run) for run in re.findall(r'`+', value)), default=0))
        padding = ' ' if value.startswith('`') or value.endswith('`') else ''
        return marker + padding + value + padding + marker
    if tag == 'pre':
        value = markdown_text(node).rstrip('\n')
        marker = '`' * max(3, 1 + max((len(run) for run in re.findall(r'`+', value)), default=0))
        return marker + 'text\n' + value + '\n' + marker + '\n\n'
    if tag in {'em', 'i', 'strong', 'b'}:
        marker = '**' if tag in {'strong', 'b'} else '*'
        return marker + text + marker
    if tag == 'a':
        href = node['attrs'].get('href')
        if not href:
            return text
        href = href.replace('(', '%28').replace(')', '%29')
        return '[' + text + '](' + href + ')'
    if tag == 'blockquote':
        return '\n'.join('> ' + line for line in text.strip().splitlines()) + '\n\n'
    if tag == 'br':
        return '  \n'
    if tag == 'hr':
        return '\n---\n\n'
    if tag in {'ul', 'ol'}:
        items = [child for child in node['children'] if not isinstance(child, str) and child['tag'] == 'li']
        lines = []
        for index, item in enumerate(items):
            marker = f'{index + 1}. ' if tag == 'ol' else '- '
            value = ''.join(markdown_node(child) for child in item['children']).strip()
            lines.append(marker + value.replace('\n', '\n  '))
        return '\n'.join(lines) + '\n\n'
    raise ValueError(f'Unsupported source element for Cell Markdown: {tag}')


def article_markdown(html):
    return render_article(html)[0]


def render_article(html):
    parser = MarkdownArticle()
    parser.feed(html)
    parser.close()
    return re.sub(r'\n{3,}', '\n\n', markdown_node(parser.root)).strip() + '\n', image_dimensions(parser.root)


def read_metadata(text):
    values = dict(re.findall(r'^- ([^:\n]+): (.+)$', text, re.MULTILINE))
    fields = {'title': 'Title', 'publisher': 'Publisher', 'author': 'Author', 'published_at': 'Published', 'retrieved_at': 'Retrieved', 'source_url': 'Canonical URL'}
    metadata = {key: values[label] for key, label in fields.items()}
    for key in ['published_at', 'retrieved_at']:
        datetime.date.fromisoformat(metadata[key])
    if urlparse(metadata['source_url']).scheme not in {'http', 'https'}:
        raise ValueError('Canonical URL must use HTTP or HTTPS.')
    return metadata


def sync_source(capture=CAPTURE, destination=SITE / 'src/content/sources'):
    metadata = read_metadata((capture / 'README.md').read_text())
    slug = urlparse(metadata['source_url']).path.rstrip('/').split('/')[-1]
    if not re.fullmatch(r'[a-z0-9]+(?:-[a-z0-9]+)*', slug):
        raise ValueError('Invalid source slug.')
    article, sizes = render_article(extract_article((capture / 'source.html').read_text(), metadata['source_url']))
    if sizes:
        metadata['image_sizes'] = sizes
    metadata.update(lang='en', description=f"Original source from {metadata['publisher']}.")
    frontmatter = '\n'.join(f'{key}: {json.dumps(value, ensure_ascii=False)}' for key, value in metadata.items())
    document = f'---\n{frontmatter}\n---\n\n{article}\n'
    destination.mkdir(parents=True, exist_ok=True)
    output = destination / f'{slug}.md'
    if not output.exists() or output.read_text() != document:
        output.write_text(document)
    return output


if __name__ == '__main__':
    for entry in json.loads((SITE / 'scripts/source-catalog.json').read_text()):
        print(f"Synced original source: {sync_source(CASES / entry['capture']).name}")
