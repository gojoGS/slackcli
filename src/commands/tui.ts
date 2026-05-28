import { Command } from 'commander';
import { getAuthenticatedClient } from '../lib/auth.ts';
import { runSlackTui } from '../lib/tui/app.ts';

export function createTuiCommand(): Command {
  const tui = new Command('tui')
    .description('Launch OpenTUI interface for conversations, reading, and sending messages')
    .option('--workspace <id|name>', 'Workspace to use')
    .option('--types <types>', 'Conversation types to load', 'private_channel,mpim,im')
    .option('--limit <number>', 'Conversation and message page size', '100')
    .option('--channel <id>', 'Preselect a channel by ID on startup')
    .action(async (options) => {
      try {
        const client = await getAuthenticatedClient(options.workspace);
        await runSlackTui(client, {
          workspaceLabel: options.workspace || 'default',
          types: options.types,
          limit: parseInt(options.limit, 10),
          channel: options.channel,
        });
      } catch (err: any) {
        console.error('TUI failed to start:', err?.message || err);
        process.exitCode = 1;
      }
    });

  return tui;
}
