import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { initialize } from '../scripts/content-store.mjs';

const binary = fileURLToPath(new URL('../bin/relay.mjs', import.meta.url));
async function fixture(t) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'relay config ')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const config = path.join(base, 'settings', 'config.json');
  const workspace = path.join(base, 'article workspace'), input = path.join(base, 'input.md');
  await writeFile(input, '## First\n\nFirst paragraph.\n\n## Second\n\nSecond paragraph.\n');
  return { base, config, workspace, input };
}
function cli(f, args, { cwd = f.base, input, env = {} } = {}) {
  const result = spawnSync(binary, [...args, '--json'], { cwd, input, encoding: 'utf8', env: { ...process.env, RELAY_CONFIG_FILE: f.config, ...env } });
  assert.equal(result.stderr, '');
  return { ...result, data: JSON.parse(result.stdout) };
}

async function prepare(f) {
  await initialize(f.workspace, f.input);
  const result = cli(f, ['config', 'set', 'workspace', 'article workspace']);
  assert.equal(result.status, 0);
  return result;
}

test('Configured workspace is absolute, persistent across processes, and independent of cwd', async t => {
  const f = await fixture(t);
  const set = await prepare(f);
  assert.equal(set.data.settings.workspace, f.workspace);
  assert.equal(set.data.config_file, f.config);
  assert.deepEqual(JSON.parse(await readFile(f.config, 'utf8')), { workspace: f.workspace });
  const elsewhere = path.join(f.base, 'another directory');
  await mkdir(elsewhere);
  const status = cli(f, ['status'], { cwd: elsewhere });
  assert.equal(status.status, 0);
  assert.equal(status.data.totals.total, 6);
  assert.deepEqual(cli(f, ['config']).data, set.data);
  assert.deepEqual(cli(f, ['config', 'get', 'workspace'], { cwd: elsewhere }).data, set.data);
});

test('Explicit workspace overrides the default without changing global settings', async t => {
  const f = await fixture(t);
  await prepare(f);
  const second = path.join(f.base, 'second article');
  await writeFile(f.input, 'Another article.\n');
  await initialize(second, f.input, { title: 'Second article' });
  const override = cli(f, ['read', '--workspace', 'second article', '--unit', 'article']);
  assert.equal(override.status, 0);
  assert.equal(override.data.title, 'Second article');
  assert.equal(override.data.content, 'Another article.\n');
  assert.equal(cli(f, ['config', 'get', 'workspace']).data.settings.workspace, f.workspace);
  assert.equal(cli(f, ['status']).data.totals.total, 6);
});

test('Pi exposes one project workspace with task-local drafts and article-specific records', async t => {
  const f = await fixture(t);
  await prepare(f);
  const second = path.join(f.base, 'second article');
  await initialize(second, f.input, { title: 'Second article' });
  const bin = path.join(f.base, 'bin');
  await mkdir(bin);
  await writeFile(path.join(bin, 'pi'), `#!/usr/bin/env node
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const option = name => args[args.indexOf(name) + 1];
const relay = (...args) => JSON.parse(execFileSync(process.execPath, [process.env.RELAY_TEST_BINARY, ...args, '--json']));
const own = relay('config');
const active = relay('read', '--unit', 'article');
const fromAlias = relay('read', '--workspace', own.settings.workspace, '--unit', 'article');
execFileSync(process.execPath, [process.env.RELAY_TEST_BINARY, 'write', '--workspace', own.settings.workspace,
  '--unit', 'article', '--field', 'brief', '--version', String(active.version), '--input', '-', '--json'], { input: active.title || 'First article' });
const config = process.env.RELAY_CONFIG_FILE;
const shared = relay('read', '--workspace', 'content/relay-demo', '--unit', 'article');
const record = path.join(option('--session-dir'), option('--session-id') + '.jsonl');
fs.writeFileSync(record, 'raw-session-record\\n');
console.log(JSON.stringify({cwd:process.cwd(), own, active:active.title, fromAlias:fromAlias.title, config,
  shared:shared.title, record, args, model:option('--model')}));
`, { mode: 0o755 });
  const checkpoint = path.join(f.base, 'editorial checkpoint.jsonl');
  await writeFile(checkpoint, 'frozen-session-record\n');
  const runs = [];
  for (const [cwd, workspace] of [[f.base, second], [second, f.workspace]]) {
    const checkpointArgs = workspace === second ? ['--checkpoint', path.basename(checkpoint)] : [];
    const result = spawnSync(binary, ['pi', '--workspace', workspace, '--model', 'test/model', ...checkpointArgs], {
      cwd, encoding: 'utf8',
      env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH, RELAY_CONFIG_FILE: f.config, RELAY_TEST_BINARY: binary },
    });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.cwd, path.resolve('.'));
    assert.deepEqual(output.own, { config_file: null, settings: { workspace: path.resolve('.') } });
    assert.equal(output.active, workspace === second ? 'Second article' : '');
    assert.equal(output.fromAlias, output.active);
    const draft = JSON.parse(await readFile(path.join(workspace, 'processed.json'), 'utf8'));
    assert.equal(draft.article.brief.text, output.active || 'First article');
    assert.equal(output.shared, 'Example Release 1.0');
    assert.equal(output.model, 'test/model');
    if (checkpointArgs.length) assert.equal(output.args[output.args.indexOf('--fork') + 1], checkpoint);
    else assert.ok(!output.args.includes('--fork'));
    for (const flag of ['--no-extensions', '--no-skills', '--no-context-files', '--no-prompt-templates', '--no-approve',
      '--system-prompt', '--append-system-prompt']) assert.ok(output.args.includes(flag), flag);
    assert.equal(output.args.filter(arg => arg === '--skill').length, 1);
    assert.equal(output.args[output.args.indexOf('--skill') + 1], path.resolve('../.agents/skills/relay/SKILL.md'));
    assert.equal(output.args[output.args.indexOf('--tools') + 1], 'read,bash,edit,write');
    assert.equal(path.dirname(output.record), path.join(workspace, '.relay', 'sessions'));
    assert.equal(await readFile(output.record, 'utf8'), 'raw-session-record\n');
    await assert.rejects(stat(output.config), { code: 'ENOENT' });
    runs.push(output);
  }
  assert.deepEqual(runs[0].own, runs[1].own);
  assert.notEqual(runs[0].config, runs[1].config);
  assert.notEqual(path.basename(runs[0].record), path.basename(runs[1].record));
  assert.equal(await readFile(checkpoint, 'utf8'), 'frozen-session-record\n');
  assert.deepEqual(JSON.parse(await readFile(f.config, 'utf8')), { workspace: f.workspace });
});

test('Missing and unset defaults give actionable errors while explicit workspace still works', async t => {
  const f = await fixture(t);
  let result = cli(f, ['status']);
  assert.equal(result.status, 1);
  assert.equal(result.data.errors[0].code, 'workspace_not_configured');
  assert.match(result.data.errors[0].message, /config set workspace/);
  assert.deepEqual(cli(f, ['config']).data.settings, {});
  assert.equal(cli(f, ['config', 'get', 'workspace']).data.errors[0].code, 'config_not_set');
  assert.deepEqual(cli(f, ['config', 'unset', 'workspace']).data.settings, {});
  await assert.rejects(stat(f.config), { code: 'ENOENT' });
  await prepare(f);
  assert.deepEqual(cli(f, ['config', 'unset', 'workspace']).data.settings, {});
  result = cli(f, ['next']);
  assert.equal(result.status, 1);
  assert.equal(result.data.errors[0].code, 'workspace_not_configured');
  assert.equal(cli(f, ['status', '--workspace', f.workspace]).status, 0);
});

test('All workspace commands can use the default, including initialization, writes and source updates', async t => {
  const f = await fixture(t);
  assert.equal(cli(f, ['config', 'set', 'workspace', f.workspace]).status, 0);
  assert.equal(cli(f, ['init', '--input', f.input, '--title', 'Configured article']).status, 0);
  assert.equal(cli(f, ['read', '--unit', 'article']).data.title, 'Configured article');
  let task;
  while ((task = cli(f, ['next']).data.task)) {
    const result = cli(f, ['write', '--unit', task.unit, '--field', task.field, '--version', String(task.version), '--input', '-'], { input: `Generated ${task.unit} ${task.field}.` });
    assert.equal(result.status, 0);
  }
  assert.equal(cli(f, ['check']).data.ok, true);
  const exported = path.join(f.base, 'export.json');
  assert.equal(cli(f, ['export', '--unit', 'article', '--out', exported]).status, 0);
  assert.equal(JSON.parse(await readFile(exported, 'utf8')).chunk_id, 'article');
  await writeFile(f.input, (await readFile(path.join(f.workspace, 'source.md'), 'utf8')).replace('First paragraph.', 'Updated paragraph.'));
  assert.equal(cli(f, ['update', '--input', f.input]).data.version, 2);
  assert.equal(cli(f, ['sync']).data.version, 2);
  assert.equal(cli(f, ['status']).data.totals.stale, 6);
  assert.equal(cli(f, ['check']).status, 1);
});

test('Malformed config fails visibly, stays intact, and can be bypassed by explicit workspace', async t => {
  const f = await fixture(t);
  await prepare(f);
  for (const text of ['broken json', 'null', '[]', '{"workspace":42}', '{"workspace":"relative/path"}', '{"unknown":true}']) {
    await writeFile(f.config, text);
    const result = cli(f, ['status']);
    assert.equal(result.status, 1);
    assert.equal(result.data.errors[0].code, 'invalid_config');
    assert.equal(cli(f, ['config', 'set', 'workspace', f.workspace]).status, 1);
    assert.equal(await readFile(f.config, 'utf8'), text);
    assert.equal(cli(f, ['status', '--workspace', f.workspace]).status, 0);
  }
});

test('Unsupported settings and malformed config commands never create a config file', async t => {
  const f = await fixture(t);
  for (const args of [
    ['config', 'set', 'model', 'example'], ['config', 'get', 'title'], ['config', 'unset', 'title'],
    ['config', 'set', 'workspace'], ['config', 'set', 'workspace', 'one', 'two'],
    ['config', 'set', 'workspace', ' '], ['config', 'get', 'workspace', 'extra'],
    ['config', '--workspace', f.workspace], ['config', 'unknown'],
  ]) {
    const result = cli(f, args);
    assert.equal(result.status, 1);
    assert.equal(result.data.ok, false);
  }
  await assert.rejects(stat(f.config), { code: 'ENOENT' });
});

test('Default config location respects XDG_CONFIG_HOME without changing HOME', async t => {
  const f = await fixture(t);
  const env = { RELAY_CONFIG_FILE: '', XDG_CONFIG_HOME: path.join(f.base, 'xdg') };
  const result = cli(f, ['config', 'set', 'workspace', f.workspace], { env });
  assert.equal(result.status, 0);
  assert.equal(result.data.config_file, path.join(env.XDG_CONFIG_HOME, 'relay', 'config.json'));
  assert.equal(cli(f, ['config', 'get', 'workspace'], { env }).data.settings.workspace, f.workspace);
  await assert.rejects(stat(f.config), { code: 'ENOENT' });
});

test('Quoted home paths expand before persisting the default', async t => {
  const f = await fixture(t);
  const result = cli(f, ['config', 'set', 'workspace', '~/relay-example']);
  assert.equal(result.status, 0);
  assert.equal(result.data.settings.workspace, path.join(os.homedir(), 'relay-example'));
});
