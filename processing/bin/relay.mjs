#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { initialize, synchronize, updateSource, rechunk, inspect, exportCase, exportDocument } from '../scripts/content-store.mjs';
import { editField, nextTask, processingStatus, readSequence, readUnit, writeField } from '../scripts/processing.mjs';
import { reviewWorkspace } from '../scripts/review.mjs';
import { launchPi } from '../scripts/pi-workspace.mjs';
import { getConfig, setConfig, unsetConfig, resolveWorkspace } from '../scripts/config.mjs';

const help = `Relay — An AI newsroom.

Usage: relay <command> [--workspace <directory>] [options]

Configuration:
  config                      Show global settings and their file path
  config set workspace <directory>
                              Save the default workspace as an absolute path
  config get [workspace]      Read global settings
  config unset workspace     Clear the default workspace

Processing:
  pi [--model <provider/model>] [--checkpoint <session.jsonl>]
                              Open Pi with this article bound to Relay commands
  status                      Show article and chunk progress
  read --unit <article|ID>     Read original content
       [--view original|brief|interpretation|all]
  read --sequence --view <brief|interpretation>
                              Read all chapter drafts in source order
  next [--unit <article|ID>] [--field brief|interpretation]
                              Get the next pending or stale field with its original
  write --unit <article|ID> --field <brief|interpretation>
        --version <integer> --input <file|->
                              Save text from a UTF-8 file or stdin
  edit --unit <article|ID> --field <brief|interpretation>
       --version <integer> --before <text> --after <text>
                              Replace one exact fragment
  review --out <file> [--model <provider/model>]
                              Review both chapter sequences in Pi and export

Workspace:
  init --input <file> [--title <text>] [--url <url>]
  update --input <edited-source.md>
  sync
  rechunk [--input <markdown-file>]
  check
  export [--document | --unit <article|ID> | --chunk <ID>] [--out <file>] [--browser <file>]

An explicit --workspace overrides the configured default.
Non-interactive commands accept --json. Names and IDs are English.
The agent generates content; this CLI reads, saves, and validates it.`;

const [command, ...args] = process.argv.slice(2);
const options = {};
const positionals = [];
const fail = message => { throw Object.assign(new Error(message), { code: 'invalid_arguments' }); };
const required = key => {
  if (typeof options[key] !== 'string' || !options[key]) fail(`Missing --${key}.`);
  return options[key];
};
function sourceVersion() {
  const value = required('version');
  if (!/^[1-9]\d*$/.test(value)) fail('--version must be a positive integer.');
  return Number(value);
}
const commands = {
  config: [],
  status: [], read: ['unit', 'view', 'sequence'], next: ['unit', 'field'], write: ['unit', 'field', 'version', 'input'],
  edit: ['unit', 'field', 'version', 'before', 'after'], review: ['out', 'model'], pi: ['model', 'checkpoint'],
  init: ['input', 'title', 'url'], update: ['input'], rechunk: ['input'], sync: [], check: [], export: ['document', 'unit', 'chunk', 'out', 'browser'],
};

try {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!arg.startsWith('--')) {
      if (command === 'config') { positionals.push(arg); continue; }
      fail(`Unexpected argument: ${arg}.`);
    }
    const inlineEdit = command === 'edit' ? /^--(before|after)=([\s\S]*)$/u.exec(arg) : null;
    const key = inlineEdit?.[1] ?? arg.slice(2);
    if (Object.hasOwn(options, key)) fail(`Duplicate --${key}.`);
    if (inlineEdit) options[key] = inlineEdit[2];
    else if (['json', 'help', 'document', 'sequence'].includes(key)) options[key] = true;
    else {
      const value = args[++index];
      if (value === undefined || (!value && key !== 'after') || value.startsWith('--')) fail(`Missing value for --${key}.`);
      options[key] = value;
    }
  }
  if (!command || command === '--help' || command === 'help' || options.help) {
    console.log(options.json ? JSON.stringify({ help }, null, 2) : help);
  } else {
    if (!Object.hasOwn(commands, command)) fail(`Unknown command: ${command}. Use --help.`);
    const allowed = new Set(['json', ...(command === 'config' ? [] : ['workspace']), ...commands[command]]);
    for (const key of Object.keys(options)) if (!allowed.has(key)) fail(`Unknown option for ${command}: --${key}.`);
    const workspace = command === 'config' ? null : await resolveWorkspace(options.workspace);
    let result;
    if (command === 'pi') {
      if (options.json) fail('Pi is an interactive command.');
      process.exit(await launchPi(workspace, options.model, options.checkpoint));
    } else if (command === 'config') {
      const [action, key, value] = positionals;
      if (!positionals.length || (action === 'get' && positionals.length <= 2)) result = await getConfig(key);
      else if (action === 'set' && positionals.length === 3) result = await setConfig(key, value);
      else if (action === 'unset' && positionals.length === 2) result = await unsetConfig(key);
      else fail('Use config, config get [workspace], config set workspace <directory>, or config unset workspace.');
    } else if (command === 'init') result = await initialize(workspace, required('input'), { title: options.title, url: options.url });
    else if (command === 'sync') result = await synchronize(workspace);
    else if (command === 'update') result = await updateSource(workspace, required('input'));
    else if (command === 'rechunk') result = await rechunk(workspace, options.input);
    else if (command === 'status') result = await processingStatus(workspace);
    else if (command === 'read') {
      if (options.sequence && options.unit) fail('Use either --sequence or --unit.');
      result = options.sequence
        ? await readSequence(workspace, required('view'))
        : await readUnit(workspace, required('unit'), options.view);
    }
    else if (command === 'next') result = await nextTask(workspace, { unit: options.unit, field: options.field });
    else if (command === 'write') {
      const unit = required('unit'), field = required('field'), input = required('input');
      const version = sourceVersion();
      let text;
      if (input === '-') {
        process.stdin.setEncoding('utf8');
        text = '';
        for await (const part of process.stdin) text += part;
      } else text = await readFile(input, 'utf8');
      result = await writeField(workspace, { unit, field, text, version });
    } else if (command === 'edit') {
      if (!Object.hasOwn(options, 'after')) fail('Missing --after.');
      result = await editField(workspace, {
        unit: required('unit'), field: required('field'), version: sourceVersion(), before: required('before'), after: options.after,
      });
    } else if (command === 'review') {
      result = await reviewWorkspace(workspace, { out: required('out'), model: options.model });
    } else if (command === 'check') {
      result = await inspect(workspace);
      if (!result.ok) process.exitCode = 1;
    } else if (command === 'export') {
      if ([options.document, options.unit, options.chunk].filter(Boolean).length > 1) fail('Use only one of --document, --unit, or --chunk.');
      result = options.document ? await exportDocument(workspace) : await exportCase(workspace, options.unit ?? options.chunk);
      const json = JSON.stringify(result, null, 2) + '\n';
      if (options.out) await writeFile(required('out'), json);
      if (options.browser) await writeFile(required('browser'), `window.READING_CASE = ${JSON.stringify(result)};\n`);
    }
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else if (command === 'status') {
      const { totals } = result;
      console.log(`Version ${result.version} | ${totals.done}/${totals.total} done | ${totals.pending} pending | ${totals.stale} stale`);
      console.log('UNIT        BRIEF       INTERPRETATION');
      for (const unit of result.units) console.log(`${unit.unit.padEnd(12)}${unit.brief.padEnd(12)}${unit.interpretation}`);
      console.log(`Ready: ${result.ready ? 'yes' : 'no'}`);
      const structural = result.errors.filter(error => !['empty_field', 'missing_field', 'stale_source', 'missing_chunk'].includes(error.code));
      for (const error of structural) console.log(`${error.code}: ${error.message}`);
    } else if (command === 'read' && options.sequence) {
      console.log(`${result.title} | ${result.view} sequence | version ${result.version}`);
      for (const chunk of result.chunks) {
        console.log(`\n${chunk.unit} | ${chunk.state}\n\n${chunk.content.trimEnd()}`);
      }
    } else if (command === 'read' && result.view !== 'all') {
      console.log(`${result.unit} | ${result.view} | version ${result.version}${result.state ? ` | ${result.state}` : ''}\n`);
      process.stdout.write(result.content);
      if (!result.content.endsWith('\n')) process.stdout.write('\n');
    } else if (command === 'check') console.log(result.ok ? `Ready: all article and chunk fields match version ${result.version}.` : result.errors.map(error => `${error.code}: ${error.message}`).join('\n'));
    else console.log(JSON.stringify(result, null, 2));
  }
} catch (error) {
  process.exitCode = 1;
  const result = { ok: false, errors: [{ code: error.code ?? 'operation_failed', message: error.message }] };
  if (options.json || args.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.error(error.message);
}
