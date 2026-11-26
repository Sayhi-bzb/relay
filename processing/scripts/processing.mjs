import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { SOURCE_FILE, TARGET_FILE, fields, parseSource, parseTarget, validate, writeTarget, emptyUnit, hasContent, withWorkspaceLock, atomicWrite } from './content-store.mjs';

const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const stateOf = (value, version) => !hasContent(value?.text) ? 'pending' : value.source_version === version ? 'done' : 'stale';
const structuralErrors = report => report.errors.filter(error => !['missing_field', 'empty_field', 'missing_chunk', 'stale_source'].includes(error.code));

async function load(workspace) {
  const [sourceText, targetText] = await Promise.all([
    readFile(path.join(workspace, SOURCE_FILE), 'utf8'),
    readFile(path.join(workspace, TARGET_FILE), 'utf8'),
  ]);
  const source = parseSource(sourceText), target = parseTarget(targetText);
  const results = new Map(target.chunks.map(chunk => [chunk.id, chunk.values]));
  const units = [
    { id: 'article', original: source.text, values: target.article },
    ...source.chunks.map(chunk => ({ id: chunk.id, original: chunk.text, values: results.get(chunk.id) ?? {} })),
  ];
  return { source, target, units, report: validate(sourceText, targetText) };
}

function assertProcessable(data) {
  const errors = structuralErrors(data.report);
  if (errors.length) fail('invalid_workspace', errors.map(error => `${error.code}: ${error.message}`).join('; '));
}

function selectUnit(data, id) {
  const unit = data.units.find(unit => unit.id === id);
  if (!unit) fail('unknown_unit', `Unknown unit: ${id}. Use article or an existing chunk ID.`);
  return unit;
}

function checkField(field) {
  if (!fields.includes(field)) fail('invalid_field', 'Field must be brief or interpretation.');
}

function progressOf(data) {
  const version = data.source.metadata.version;
  const totals = { total: data.units.length * fields.length, done: 0, pending: 0, stale: 0 };
  const units = data.units.map(unit => {
    const states = Object.fromEntries(fields.map(field => {
      const state = stateOf(unit.values[field], version);
      totals[state]++;
      return [field, state];
    }));
    return { unit: unit.id, ...states };
  });
  return { version, totals, ready: data.report.ok, units, errors: structuralErrors(data.report) };
}

export async function processingStatus(workspace) {
  return progressOf(await load(workspace));
}

export async function readUnit(workspace, id, view = 'original') {
  if (!['original', 'brief', 'interpretation', 'all'].includes(view)) fail('invalid_view', 'View must be original, brief, interpretation, or all.');
  const data = await load(workspace);
  assertProcessable(data);
  const unit = selectUnit(data, id), version = data.source.metadata.version;
  const base = { unit: id, version, title: data.source.metadata.title, url: data.source.metadata.url, view };
  if (view === 'original') return { ...base, content: unit.original };
  const valueOf = field => ({ ...(unit.values[field] ?? { text: '', source_version: null }), state: stateOf(unit.values[field], version) });
  if (view === 'all') return { ...base, original: unit.original, brief: valueOf('brief'), interpretation: valueOf('interpretation') };
  const value = valueOf(view);
  return { ...base, source_version: value.source_version, state: value.state, content: value.text };
}

export async function readSequence(workspace, view) {
  checkField(view);
  const data = await load(workspace);
  assertProcessable(data);
  const { version, title, url } = data.source.metadata;
  const chunks = data.units.slice(1).map(unit => {
    const value = unit.values[view];
    return { unit: unit.id, state: stateOf(value, version), content: value?.text ?? '' };
  });
  return { view, version, title, url, chunks };
}

export async function editField(workspace, { unit: id, field, before, after, version }) {
  checkField(field);
  if (!Number.isSafeInteger(version) || version < 1) fail('invalid_version', 'Provide the positive integer version returned by read.');
  if (typeof before !== 'string' || !before.trim() || typeof after !== 'string') fail('invalid_edit', 'Provide a nonempty before fragment and a replacement.');
  return withWorkspaceLock(workspace, async () => {
    const data = await load(workspace);
    assertProcessable(data);
    const unit = selectUnit(data, id);
    if (version !== data.source.metadata.version) fail('version_conflict', `Source is version ${data.source.metadata.version}; read it again before editing.`);
    const value = unit.values[field];
    if (stateOf(value, version) !== 'done') fail('field_not_ready', 'Edit requires a completed field on the current source version.');
    const start = value.text.indexOf(before);
    if (start < 0) fail('edit_conflict', 'The before fragment is no longer present. Read the field again.');
    if (value.text.indexOf(before, start + 1) !== -1) fail('ambiguous_edit', 'The before fragment occurs more than once. Include more local context.');
    const prefix = value.text.slice(0, start), suffix = value.text.slice(start + before.length);
    if (!prefix.trim() && !suffix.trim()) fail('whole_field_edit', 'Use write for a full field replacement.');
    const text = prefix + after + suffix;
    if (!hasContent(text)) fail('empty_field', 'The edit would leave the field empty or a placeholder.');
    const changed = before !== after;
    if (changed) {
      value.text = text;
      await atomicWrite(path.join(workspace, TARGET_FILE), writeTarget(data.target.metadata, data.target.chunks, data.target.article));
    }
    return { unit: id, field, version, state: 'done', changed, diff: { before, after } };
  });
}

export async function nextTask(workspace, { unit: id, field } = {}) {
  if (field !== undefined) checkField(field);
  const data = await load(workspace);
  assertProcessable(data);
  const units = id === undefined ? data.units : [selectUnit(data, id)];
  const version = data.source.metadata.version;
  for (const unit of units) for (const candidate of field === undefined ? fields : [field]) {
    const value = unit.values[candidate], state = stateOf(value, version);
    if (state !== 'done') return {
      version, ready: false,
      task: { unit: unit.id, field: candidate, version, title: data.source.metadata.title, url: data.source.metadata.url, original: unit.original, previous: { ...(value ?? { text: '', source_version: null }), state } },
    };
  }
  return { version, ready: data.report.ok, task: null };
}

export async function writeField(workspace, { unit: id, field, text, version }) {
  checkField(field);
  if (!Number.isSafeInteger(version) || version < 1) fail('invalid_version', 'Provide the positive integer version returned by read or next.');
  if (typeof text !== 'string' || !hasContent(text)) fail('empty_field', 'Content must be nonempty and cannot be a placeholder.');
  return withWorkspaceLock(workspace, async () => {
    const data = await load(workspace);
    assertProcessable(data);
    const unit = selectUnit(data, id);
    if (version !== data.source.metadata.version) fail('version_conflict', `Source is version ${data.source.metadata.version}; read it again before writing.`);
    const value = { text, source_version: version };
    const changed = unit.values[field]?.text !== text || unit.values[field]?.source_version !== version;
    data.target.article = { ...emptyUnit(version), ...data.target.article };
    if (id === 'article') data.target.article[field] = value;
    else {
      let chunk = data.target.chunks.find(chunk => chunk.id === id);
      if (!chunk) {
        chunk = { id, values: emptyUnit(version) };
        data.target.chunks.push(chunk);
      }
      chunk.values = { ...emptyUnit(version), ...chunk.values, [field]: value };
    }
    await atomicWrite(path.join(workspace, TARGET_FILE), writeTarget(data.target.metadata, data.target.chunks, data.target.article));
    return { unit: id, field, version, state: 'done', changed };
  });
}
