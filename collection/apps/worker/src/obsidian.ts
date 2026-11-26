import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);

export async function exportObsidian(database: string, vault: string) {
  const script = fileURLToPath(new URL('../scripts/export_obsidian.py', import.meta.url));
  const { stdout } = await execute('python3', [script, '--database', database, '--vault', vault],
    { timeout: 300_000, maxBuffer: 1024 * 1024 });
  const summary = JSON.parse(stdout.trim());
  console.log(JSON.stringify({ obsidian: summary }));
  return summary;
}
