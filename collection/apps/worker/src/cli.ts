import { Command } from 'commander';
import { loadConfig } from './config.js';
import { WorkerRuntime } from './runtime.js';
import { exportObsidian } from './obsidian.js';

const program = new Command().name('ai-radar-worker');
program.command('apply-content-policy').description('Disable streams outside the version-update policy')
  .option('--apply', 'Apply the listed stream changes; otherwise preview only')
  .action(async ({ apply }) => {
    console.log(JSON.stringify(await new WorkerRuntime(loadConfig()).applyContentPolicy(Boolean(apply)), null, 2));
  });
program.command('export-obsidian').description('Export SQLite into a Markdown vault without Feishu access')
  .option('--database <path>', 'SQLite catalog', process.env.SOURCE_DB_PATH ?? '/var/lib/ai-news-radar/source.sqlite')
  .requiredOption('--vault <path>', 'Vault directory')
  .action(async ({ database, vault }) => {
    await exportObsidian(database, vault);
  });
program.command('run').description('Run one collection and synchronization cycle').action(async () => {
  const runtime = new WorkerRuntime(loadConfig());
  await runtime.run();
  console.log(JSON.stringify({ ok: true }));
});
program.command('doctor').description('Check Feishu Base and sources').action(async () => {
  console.log(JSON.stringify(await new WorkerRuntime(loadConfig()).doctor(), null, 2));
});
program.command('sync').description('Project pending SQLite source events into Feishu').action(async () => {
  await new WorkerRuntime(loadConfig()).sync();
  console.log(JSON.stringify({ ok: true }));
});
program.command('langflow-smoke').description('Run bounded Langflow capacity requests')
  .option('--sequential <count>', 'Sequential calls after warmup', '3')
  .option('--concurrent <count>', 'Concurrent calls after sequential calls', '2')
  .action(async ({ sequential, concurrent }) => {
    const parseCount = (value: string, name: string) => {
      const parsed = Number(value)
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > 10) throw new Error(`${name} must be an integer from 0 to 10`)
      return parsed
    }
    const result = await new WorkerRuntime(loadConfig()).langflowSmoke(parseCount(sequential, 'sequential'), parseCount(concurrent, 'concurrent'))
    console.log(JSON.stringify(result, null, 2))
  });
program.command('reprocess-latest').description('Reprocess the latest Feishu news item through Langflow')
  .option('--stream-key <key>', 'Only select news from this subscription stream')
  .action(async ({ streamKey }: { streamKey?: string }) => {
    console.log(JSON.stringify(await new WorkerRuntime(loadConfig()).reprocessLatest(streamKey), null, 2))
  });
await program.parseAsync();
