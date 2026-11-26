import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const content = path.join(root, 'content');
const relaySkill = fileURLToPath(new URL('../../.agents/skills/relay/SKILL.md', import.meta.url));

export async function preparePiWorkspace(workspace, scratch) {
  const article = await realpath(workspace);
  const id = path.basename(article);
  const sessions = path.dirname(article) === await realpath(content)
    ? path.join(root, '.relay', 'sessions', id)
    : path.join(article, '.relay', 'sessions');
  const config = path.join(scratch, 'relay-config.json');
  await mkdir(sessions, { recursive: true, mode: 0o700 });
  await writeFile(config, JSON.stringify({ workspace: article }) + '\n', { mode: 0o600 });
  return {
    args: ['--session-dir', sessions, '--session-id', randomUUID()],
    options: { cwd: root, env: { ...process.env, RELAY_CONFIG_FILE: config, RELAY_SESSION_ROOT: path.resolve(root) } },
  };
}

export async function launchPi(workspace, model, checkpoint) {
  const checkpointPath = checkpoint ? await realpath(checkpoint) : null;
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'relay-pi-'));
  try {
    const { args, options } = await preparePiWorkspace(workspace, scratch);
    args.push(
      '--no-extensions', '--no-skills', '--no-context-files', '--no-prompt-templates', '--no-themes', '--no-approve',
      '--skill', relaySkill,
      '--tools', 'read,bash,edit,write',
      '--system-prompt', 'You are an editorial agent working on Relay article drafts. Follow the user’s instructions for this task.',
      '--append-system-prompt', 'Use the Relay CLI to inspect the active article workspace and save its reading views.',
    );
    if (checkpointPath) args.push('--fork', checkpointPath);
    if (model) args.push('--model', model);
    return await new Promise((resolve, reject) => {
      const child = spawn('pi', args, { ...options, stdio: 'inherit' });
      child.once('error', reject);
      child.once('close', status => resolve(status ?? 1));
    });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
