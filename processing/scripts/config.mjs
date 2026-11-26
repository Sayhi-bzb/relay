import { readFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { atomicWrite } from './content-store.mjs';

const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const resolvePath = value => path.resolve(value === '~' ? os.homedir() : value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value);
export const configPath = () => process.env.RELAY_CONFIG_FILE ? resolvePath(process.env.RELAY_CONFIG_FILE) : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'relay', 'config.json');
const sessionRoot = () => process.env.RELAY_CONFIG_FILE && process.env.RELAY_SESSION_ROOT
  ? resolvePath(process.env.RELAY_SESSION_ROOT)
  : undefined;

function configView(settings) {
  const root = sessionRoot();
  if (!root) return { config_file: configPath(), settings };
  return { config_file: null, settings: settings.workspace ? { workspace: root } : {} };
}

function checkKey(key) {
  if (key !== 'workspace') fail('invalid_config_key', 'Supported setting: workspace.');
}

async function loadConfig() {
  const filename = configPath();
  let text;
  try { text = await readFile(filename, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  let settings;
  try { settings = JSON.parse(text); }
  catch { fail('invalid_config', `Invalid JSON in ${filename}.`); }
  if (settings === null || typeof settings !== 'object' || Array.isArray(settings) || Object.keys(settings).some(key => key !== 'workspace') || (Object.hasOwn(settings, 'workspace') && (typeof settings.workspace !== 'string' || !path.isAbsolute(settings.workspace)))) fail('invalid_config', `Invalid settings in ${filename}; workspace must be an absolute path.`);
  return settings;
}

export async function getConfig(key) {
  if (key !== undefined) checkKey(key);
  const settings = await loadConfig();
  if (key !== undefined && !Object.hasOwn(settings, key)) fail('config_not_set', `Setting ${key} is not configured.`);
  return configView(settings);
}

export async function setConfig(key, value) {
  checkKey(key);
  if (typeof value !== 'string' || !value.trim()) fail('invalid_config_value', 'Workspace must be a nonempty directory path.');
  const settings = { ...await loadConfig(), [key]: await resolveWorkspace(value) };
  const filename = configPath();
  await mkdir(path.dirname(filename), { recursive: true });
  await atomicWrite(filename, JSON.stringify(settings, null, 2) + '\n');
  return configView(settings);
}

export async function unsetConfig(key) {
  checkKey(key);
  const settings = await loadConfig();
  if (Object.hasOwn(settings, key)) {
    delete settings[key];
    await atomicWrite(configPath(), JSON.stringify(settings, null, 2) + '\n');
  }
  return configView(settings);
}

export async function resolveWorkspace(explicit) {
  if (explicit !== undefined) {
    const requested = resolvePath(explicit);
    if (requested !== sessionRoot()) return requested;
  }
  const settings = await loadConfig();
  if (!settings.workspace) fail('workspace_not_configured', 'No workspace configured. Run relay config set workspace <directory> or pass --workspace.');
  return settings.workspace;
}
