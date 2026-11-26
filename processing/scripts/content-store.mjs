import MarkdownIt from 'markdown-it';
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

const markdown = new MarkdownIt({ html: true });
export const SOURCE_FILE = 'source.md';
export const TARGET_FILE = 'processed.json';
const idPattern = /^c\d{4,}$/;
export const fields = ['brief', 'interpretation'];
const normalize = text => text.replace(/\r\n?/g, '\n');
const linesOf = text => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];

export function readDocument(text) {
  text = normalize(text);
  const match = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) throw new Error('缺少文件元数据');
  const metadata = {};
  for (const line of match[1].split('\n')) {
    const entry = line.match(/^([a-z][a-z0-9_]*):\s*(.+)$/);
    if (!entry || Object.hasOwn(metadata, entry[1])) throw new Error(`无效或重复的元数据：${line}`);
    metadata[entry[1]] = JSON.parse(entry[2]);
  }
  return { metadata, body: text.slice(match[0].length) };
}

export function writeDocument(metadata, body) {
  return `---\n${Object.entries(metadata).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n')}\n---\n${body}`;
}

export function splitMarkdown(text) {
  text = normalize(text);
  if (!text.trim()) return [];
  const lines = linesOf(text);
  const tokens = markdown.parse(text, {}).filter(token => token.level === 0 && token.map);
  const headings = tokens.filter(token => token.type === 'heading_open' && token.tag === 'h2');
  if (!headings.length) return [text];
  const starts = headings.map(token => token.map[0]);
  const intro = tokens.some(token => token.map[0] < starts[0] && token.type !== 'heading_open' && !(token.type === 'html_block' && /^\s*(?:<!--[\s\S]*?-->\s*)+$/.test(token.content)));
  if (intro) starts.unshift(0);
  else starts[0] = 0;
  return starts.map((start, index) => lines.slice(start, starts[index + 1] ?? lines.length).join(''));
}

export function parseSource(text) {
  const { metadata, body } = readDocument(text);
  const lines = linesOf(body);
  const markers = markdown.parse(body, {}).filter(token => token.type === 'html_block' && token.level === 0 && /^<!--\s*\/?chunk\b/.test(token.content.trim()));
  const pieces = [];
  let cursor = 0;
  let open = null;
  for (const marker of markers) {
    const value = marker.content.trim();
    const opening = value.match(/^<!-- chunk:(c\d{4,}) -->$/);
    const closing = value === '<!-- /chunk -->';
    if (!opening && !closing) throw new Error(`无效 chunk 标记：${value}`);
    if (opening) {
      if (open) throw new Error(`chunk ${open.id} 没有闭合`);
      if (marker.map[0] > cursor) pieces.push({ id: null, text: lines.slice(cursor, marker.map[0]).join('') });
      open = { id: opening[1], start: marker.map[1] };
    } else {
      if (!open) throw new Error('存在没有起始标记的 chunk');
      pieces.push({ id: open.id, text: lines.slice(open.start, marker.map[0]).join('') });
      open = null;
    }
    cursor = marker.map[1];
  }
  if (open) throw new Error(`chunk ${open.id} 没有闭合`);
  if (cursor < lines.length) pieces.push({ id: null, text: lines.slice(cursor).join('') });
  const chunks = pieces.filter(piece => piece.id);
  return { metadata, pieces, chunks, text: pieces.map(piece => piece.text).join('') };
}

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validVersion = version => Number.isSafeInteger(version) && version > 0;

export function parseTarget(text) {
  const data = JSON.parse(text);
  const tokens = text.match(/"(?:\\.|[^"\\])*"|[{}\[\]:,]/g) ?? [];
  const stack = [];
  for (const [index, token] of tokens.entries()) {
    if (token === '{') stack.push(new Set());
    else if (token === '[') stack.push(null);
    else if (token === '}' || token === ']') stack.pop();
    else if (token.startsWith('"') && tokens[index + 1] === ':') {
      const key = JSON.parse(token), keys = stack.at(-1);
      if (keys.has(key)) throw new Error(`重复 JSON key：${key}`);
      keys.add(key);
    }
  }
  if (!isObject(data) || Object.keys(data).some(key => !['source', 'source_version', 'article', 'chunks'].includes(key))) throw new Error('加工稿只能包含 source、article、chunks');
  if (!isObject(data.chunks)) throw new Error('chunks 必须是以 chunk ID 为 key 的对象');
  const legacy = Object.hasOwn(data, 'source_version');
  const parseUnit = (id, values) => {
    if (!isObject(values) || Object.keys(values).some(key => !fields.includes(key))) throw new Error(`${id} 只能包含 brief 和 interpretation`);
    return Object.fromEntries(Object.entries(values).map(([field, value]) => {
      if (legacy && typeof value === 'string') return [field, { text: value, source_version: data.source_version }];
      if (!isObject(value) || Object.keys(value).some(key => !['text', 'source_version'].includes(key)) || typeof value.text !== 'string') throw new Error(`${id}.${field} 必须包含 text 字符串和 source_version`);
      return [field, value];
    }));
  };
  const chunks = Object.entries(data.chunks).map(([id, values]) => {
    if (!idPattern.test(id)) throw new Error(`无效 chunk ID：${id}`);
    return { id, values: parseUnit(id, values) };
  });
  return { metadata: { source: data.source }, article: parseUnit('article', data.article ?? {}), chunks };
}

export function writeTarget(metadata, chunks, article) {
  return JSON.stringify({ source: metadata.source, article, chunks: Object.fromEntries(chunks.map(chunk => [chunk.id, chunk.values])) }, null, 2) + '\n';
}

function duplicates(chunks) {
  const seen = new Set();
  const repeated = [];
  for (const chunk of chunks) {
    if (seen.has(chunk.id)) repeated.push(chunk.id);
    seen.add(chunk.id);
  }
  return repeated;
}

export function hasContent(text) {
  const clean = (text ?? '').replace(/<!--[\s\S]*?-->/g, '').trim();
  return Boolean(clean) && !/^(?:TODO|TBD|待填写|待处理|待补充|[.。…?？]+|\[\s*\]|\(待填写\))$/iu.test(clean);
}

export function validate(sourceText, targetText) {
  const errors = [];
  let source, target;
  try { source = parseSource(sourceText); } catch (error) { errors.push({ code: 'invalid_source', message: error.message }); }
  try { target = parseTarget(targetText); } catch (error) { errors.push({ code: 'invalid_target', message: error.message }); }
  if (!source || !target) return { ok: false, errors };
  const add = (code, message, extra = {}) => errors.push({ code, ...extra, message });
  if (!source.chunks.length) add('empty_source', '原文没有 chunk');
  for (const id of duplicates(source.chunks)) add('duplicate_source_id', `原文 ID 重复：${id}`, { chunk_id: id });
  if (source.pieces.some(piece => !piece.id && piece.text.trim())) add('unmarked_source', '原文存在未分配 ID 的内容，请运行 sync');
  for (const chunk of source.chunks) if (!chunk.text.trim()) add('empty_source_chunk', `原文 ${chunk.id} 为空`, { chunk_id: chunk.id });
  const sourceIds = new Set(source.chunks.map(chunk => chunk.id));
  const targetIds = new Set(target.chunks.map(chunk => chunk.id));
  for (const id of sourceIds) if (!targetIds.has(id)) add('missing_chunk', `加工稿缺少 ${id}`, { chunk_id: id });
  for (const id of targetIds) if (!sourceIds.has(id)) add('unknown_chunk', `加工稿引用了不存在的 ${id}`, { chunk_id: id });
  if (target.metadata.source !== SOURCE_FILE) add('invalid_reference', `加工稿必须引用 ${SOURCE_FILE}`);
  if (!validVersion(source.metadata.version)) add('invalid_version', '原文 version 必须是正整数');
  for (const unit of [{ id: 'article', values: target.article }, ...target.chunks]) for (const field of fields) {
    const extra = { unit: unit.id, ...(unit.id === 'article' ? {} : { chunk_id: unit.id }), field };
    const value = unit.values[field];
    if (!value) add('missing_field', `${unit.id} 缺少 ${field}`, extra);
    else {
      if (!hasContent(value.text)) add('empty_field', `${unit.id} 的 ${field} 未填写`, extra);
      if (!validVersion(value.source_version) || (validVersion(source.metadata.version) && value.source_version > source.metadata.version)) add('invalid_source_version', `${unit.id}.${field} 的 source_version 必须是正整数且不能领先原文`, extra);
      else if (validVersion(source.metadata.version) && hasContent(value.text) && value.source_version !== source.metadata.version) add('stale_source', `${unit.id}.${field} 原文版本变化；请复核后通过 write 提交`, extra);
    }
  }
  return { ok: errors.length === 0, source_chunks: source.chunks.length, target_chunks: target.chunks.length, version: source.metadata.version, errors };
}

async function exists(filename) {
  try { await stat(filename); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

export async function atomicWrite(filename, text) {
  const temp = `${filename}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, text, { flag: 'wx' });
    await rename(temp, filename);
  } finally {
    await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

export async function withWorkspaceLock(workspace, action) {
  const lockPath = path.join(workspace, '.content.lock');
  let handle;
  try { handle = await open(lockPath, 'wx'); }
  catch (error) {
    if (error.code === 'EEXIST') throw Object.assign(new Error('Workspace is busy; retry after the current command finishes.'), { code: 'workspace_busy' });
    throw error;
  }
  try { await handle.writeFile(`${process.pid}\n`); return await action(); }
  finally { await handle.close(); await unlink(lockPath); }
}

export const emptyUnit = version => Object.fromEntries(fields.map(field => [field, { text: '', source_version: version }]));
const slot = (id, version) => ({ id, values: emptyUnit(version) });
const sourceBody = pieces => pieces.map(piece => piece.id ? `<!-- chunk:${piece.id} -->\n${piece.text}${piece.text.endsWith('\n') ? '' : '\n'}<!-- /chunk -->\n` : piece.text).join('');

async function initializeSource(workspace, input, { title = '', url = '' } = {}) {
  if (await exists(path.join(workspace, SOURCE_FILE)) || await exists(path.join(workspace, TARGET_FILE))) throw new Error('工作区已存在，使用 sync；初始化不会覆盖文件');
  let text = normalize(await readFile(input, 'utf8'));
  if (!text.endsWith('\n')) text += '\n';
  const blocks = splitMarkdown(text);
  if (!blocks.length) throw new Error('原文为空');
  if (markdown.parse(text, {}).some(token => token.type === 'html_block' && /^<!--\s*\/?chunk\b/.test(token.content.trim()))) throw new Error('输入已包含 chunk 标记，请使用 sync');
  const chunks = blocks.map((body, index) => ({ id: `c${String(index + 1).padStart(4, '0')}`, text: body }));
  await mkdir(workspace, { recursive: true });
  const original = writeDocument({ title, url, version: 1, next_chunk: chunks.length + 1 }, sourceBody(chunks));
  const target = writeTarget({ source: SOURCE_FILE }, chunks.map(chunk => slot(chunk.id, 1)), emptyUnit(1));
  await writeFile(path.join(workspace, SOURCE_FILE), original, { flag: 'wx' });
  await writeFile(path.join(workspace, TARGET_FILE), target, { flag: 'wx' });
  return { workspace, chunks: chunks.length, version: 1 };
}

async function synchronizeSource(workspace, input) {
  const sourcePath = path.join(workspace, SOURCE_FILE), targetPath = path.join(workspace, TARGET_FILE);
  const current = parseSource(await readFile(sourcePath, 'utf8'));
  if (!validVersion(current.metadata.version)) throw new Error('原文 version 必须是正整数');
  if (input && path.resolve(input) === path.resolve(sourcePath)) throw new Error('update 的 input 必须是原文的编辑副本，不能覆盖当前 source.md 后再更新');
  const source = input ? parseSource(await readFile(input, 'utf8')) : current;
  if (source.metadata.version !== current.metadata.version) throw new Error('编辑副本的 version 必须与当前原文一致，请从最新 source.md 开始编辑');
  const target = await exists(targetPath) ? parseTarget(await readFile(targetPath, 'utf8')) : null;
  if (duplicates(source.chunks).length) throw new Error('ID 重复，停止同步，未覆盖文件');
  if (target && (target.metadata.source !== SOURCE_FILE || [target.article, ...target.chunks.map(chunk => chunk.values)].some(unit => Object.values(unit).some(value => !validVersion(value.source_version) || value.source_version > current.metadata.version)))) throw new Error('加工稿来源或版本无效，停止同步，未覆盖文件');
  const signature = document => JSON.stringify([document.pieces, Object.entries(document.metadata).filter(([key]) => !['version', 'next_chunk'].includes(key)).sort(([a], [b]) => a.localeCompare(b))]);
  const changed = Boolean(input) && signature(source) !== signature(current);
  const version = current.metadata.version + Number(changed);
  if (!validVersion(version)) throw new Error('version 超出安全整数范围');
  let next = Math.max(Number.isSafeInteger(current.metadata.next_chunk) ? current.metadata.next_chunk : 1, Number.isSafeInteger(source.metadata.next_chunk) ? source.metadata.next_chunk : 1, ...[...current.chunks, ...source.chunks, ...(target?.chunks ?? [])].map(chunk => Number(chunk.id.slice(1)) + 1));
  const added = [];
  const pieces = source.pieces.flatMap(piece => {
    if (piece.id || !piece.text.trim()) return [piece];
    return splitMarkdown(piece.text).map(text => {
      const id = `c${String(next++).padStart(4, '0')}`;
      added.push(id);
      return { id, text };
    });
  });
  const chunks = pieces.filter(piece => piece.id);
  const existing = new Map((target?.chunks ?? []).map(chunk => [chunk.id, chunk]));
  const ids = new Set(chunks.map(chunk => chunk.id));
  const orphaned = (target?.chunks ?? []).filter(chunk => !ids.has(chunk.id));
  const missing = chunks.filter(chunk => !existing.has(chunk.id)).map(chunk => chunk.id);
  const results = [...chunks.map(chunk => ({ id: chunk.id, values: { ...emptyUnit(version), ...(existing.get(chunk.id)?.values ?? {}) } })), ...orphaned];
  const metadata = target?.metadata ?? { source: SOURCE_FILE };
  const article = { ...emptyUnit(version), ...target?.article };
  await atomicWrite(sourcePath, writeDocument({ ...source.metadata, version, next_chunk: next }, sourceBody(pieces)));
  await atomicWrite(targetPath, writeTarget(metadata, results, article));
  const sourceChanged = [article, ...results.map(chunk => chunk.values)].some(unit => fields.some(field => hasContent(unit[field]?.text) && unit[field].source_version !== version));
  return { workspace, added, missing_slots_added: missing, orphaned_preserved: orphaned.map(chunk => chunk.id), version, source_changed: sourceChanged };
}

export async function initialize(workspace, input, options) {
  await mkdir(workspace, { recursive: true });
  return withWorkspaceLock(workspace, () => initializeSource(workspace, input, options));
}

export const synchronize = workspace => withWorkspaceLock(workspace, () => synchronizeSource(workspace));
export const updateSource = (workspace, input) => withWorkspaceLock(workspace, () => synchronizeSource(workspace, input));

export const rechunk = (workspace, input) => withWorkspaceLock(workspace, async () => {
  const sourcePath = path.join(workspace, SOURCE_FILE), targetPath = path.join(workspace, TARGET_FILE);
  const sourceText = await readFile(sourcePath, 'utf8'), targetText = await readFile(targetPath, 'utf8');
  const report = validate(sourceText, targetText);
  const structural = report.errors.filter(error => !['empty_field', 'missing_field', 'stale_source'].includes(error.code));
  if (structural.length) throw new Error(`Cannot rechunk an invalid workspace: ${structural.map(error => error.message).join('; ')}`);
  const source = parseSource(sourceText), target = parseTarget(targetText);
  let text = input ? normalize(await readFile(input, 'utf8')) : source.text;
  if (!text.endsWith('\n')) text += '\n';
  if (markdown.parse(text, {}).some(token => token.type === 'html_block' && /^<!--\s*\/?chunk\b/.test(token.content.trim()))) throw new Error('Rechunk input must be plain Markdown without chunk markers.');
  const blocks = splitMarkdown(text);
  if (!blocks.length) throw new Error('原文为空');
  if (text === source.text && blocks.length === source.chunks.length && blocks.every((block, index) => block === source.chunks[index].text)) return { workspace, changed: false, chunks: blocks.length, version: source.metadata.version };
  const version = source.metadata.version + 1;
  let next = Math.max(Number.isSafeInteger(source.metadata.next_chunk) ? source.metadata.next_chunk : 1, ...[...source.chunks, ...target.chunks].map(chunk => Number(chunk.id.slice(1)) + 1));
  if (!validVersion(version) || !Number.isSafeInteger(next + blocks.length)) throw new Error('Version or chunk ID exceeds the safe integer range.');
  const chunks = blocks.map(text => ({ id: `c${String(next++).padStart(4, '0')}`, text }));
  const history = path.join(workspace, '.history', `rechunk-v${source.metadata.version}-${randomUUID()}`);
  await mkdir(history, { recursive: true });
  await writeFile(path.join(history, SOURCE_FILE), sourceText, { flag: 'wx' });
  await writeFile(path.join(history, TARGET_FILE), targetText, { flag: 'wx' });
  try {
    await atomicWrite(sourcePath, writeDocument({ ...source.metadata, version, next_chunk: next }, sourceBody(chunks)));
    await atomicWrite(targetPath, writeTarget(target.metadata, chunks.map(chunk => slot(chunk.id, version)), target.article));
  } catch (error) {
    await atomicWrite(sourcePath, sourceText);
    await atomicWrite(targetPath, targetText);
    throw error;
  }
  return { workspace, changed: true, chunks: chunks.length, added: chunks.map(chunk => chunk.id), version, history };
});

export async function inspect(workspace) {
  const [source, target] = await Promise.all([readFile(path.join(workspace, SOURCE_FILE), 'utf8'), readFile(path.join(workspace, TARGET_FILE), 'utf8')]);
  return validate(source, target);
}

export async function exportCase(workspace, chunkId) {
  const result = await inspect(workspace);
  if (!result.ok) throw new Error(`完整性检查失败：${result.errors.map(error => error.message).join('；')}`);
  const source = parseSource(await readFile(path.join(workspace, SOURCE_FILE), 'utf8'));
  const target = parseTarget(await readFile(path.join(workspace, TARGET_FILE), 'utf8'));
  const chunk = chunkId === 'article' ? { id: 'article', text: source.text } : chunkId ? source.chunks.find(item => item.id === chunkId) : source.chunks[0];
  if (!chunk) throw new Error(`不存在 chunk：${chunkId}`);
  const values = chunk.id === 'article' ? target.article : target.chunks.find(item => item.id === chunk.id).values;
  return { source: { title: source.metadata.title, url: source.metadata.url }, chunk_id: chunk.id, original: chunk.text.trim(), brief: values.brief.text, interpretation: values.interpretation.text.split(/\n\s*\n/) };
}

export async function exportDocument(workspace) {
  const result = await inspect(workspace);
  if (!result.ok) throw new Error(`完整性检查失败：${result.errors.map(error => error.message).join('；')}`);
  const source = parseSource(await readFile(path.join(workspace, SOURCE_FILE), 'utf8'));
  const target = parseTarget(await readFile(path.join(workspace, TARGET_FILE), 'utf8'));
  const units = new Map(target.chunks.map(chunk => [chunk.id, chunk.values]));
  const unit = (id, original, values) => ({ id, original: original.trim(), brief: values.brief.text.trim(), interpretation: values.interpretation.text.trim() });
  return {
    source: { title: source.metadata.title, url: source.metadata.url, version: source.metadata.version },
    article: unit('article', source.text, target.article),
    chunks: source.chunks.map(chunk => unit(chunk.id, chunk.text, units.get(chunk.id))),
  };
}
