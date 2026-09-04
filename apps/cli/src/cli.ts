import { Command, InvalidArgumentError } from 'commander';
import { serveCommand } from './commands/serve.js';
import {
  configInitCommand,
  configPathCommand,
  configShowCommand,
  configValidateCommand,
  generateTokenCommand
} from './commands/config.js';
import { statusCommand } from './commands/status.js';
import { stopCommand } from './commands/stop.js';
import { logsCommand } from './commands/logs.js';
import { doctorCommand } from './commands/doctor.js';
import { serviceCommand, type ServiceAction } from './commands/service.js';

export type CliIo = { stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream };

export async function runCli(argv = process.argv, io: CliIo = process): Promise<void> {
  const program = new Command();
  program
    .name('jojo')
    .description('Jojo Agent command line interface')
    .version(`jojo 0.1.0\nprotocol 1\nnode ${process.versions.node}`)
    .configureOutput({ writeOut: (text) => io.stdout.write(text), writeErr: (text) => io.stderr.write(text) });

  program.command('serve')
    .description('Run the Jojo server in the foreground')
    .option('--config <path>')
    .option('--data-dir <path>')
    .option('--host <host>')
    .option('--port <port>', 'listening port', integer)
    .option('--allow-remote')
    .option('--token <token>')
    .option('--token-env <name>')
    .option('--log-level <level>', 'trace|debug|info|warn|error|fatal')
    .option('--log-format <format>', 'json|pretty')
    .option('--log-file <path>')
    .option('--instance-id <id>')
    .option('--pid-file <path>')
    .option('--shutdown-timeout <ms>', 'shutdown timeout in milliseconds', integer)
    .option('--print-effective-config')
    .option('--check')
    .option('--quiet')
    .option('--daemon')
    .action((options) => serveCommand(options, io.stdout));

  program.command('status')
    .description('Show server process and health status')
    .option('--config <path>').option('--instance-id <id>').option('--json').option('--quiet')
    .action((options) => statusCommand(options, io.stdout));

  program.command('stop')
    .description('Gracefully stop a manually managed server')
    .option('--config <path>').option('--instance-id <id>').option('--timeout <ms>', 'wait timeout', integer).option('--force')
    .action((options) => stopCommand(options, io.stdout));

  program.command('logs')
    .description('Read server logs')
    .option('--config <path>').option('--instance-id <id>').option('-f, --follow').option('-n, --lines <count>', 'line count', integer)
    .option('--level <level>').option('--file', 'read the application log instead of the OS journal')
    .action((options) => logsCommand(options, io.stdout));

  program.command('doctor')
    .description('Run server diagnostics')
    .option('--config <path>').option('--instance-id <id>').option('--json')
    .action((options) => doctorCommand(options, io.stdout));

  const config = program.command('config').description('Inspect and manage configuration');
  config.command('path').option('--config <path>').action((options) => configPathCommand(options, io.stdout));
  config.command('init').option('--config <path>').option('--force').action((options) => configInitCommand(options, io.stdout));
  config.command('show').option('--config <path>').option('--effective').action((options) => configShowCommand(options, io.stdout));
  config.command('validate').option('--config <path>').action((options) => configValidateCommand(options, io.stdout));
  config.command('generate-token').action(() => generateTokenCommand(io.stdout));

  const service = program.command('service').description('Manage the OS user service');
  for (const action of ['install', 'uninstall', 'start', 'stop', 'restart', 'status'] as ServiceAction[]) {
    service.command(action).option('--config <path>').option('--instance-id <id>').option('--json')
      .action((options) => serviceCommand(action, options, io.stdout));
  }
  await program.parseAsync(argv);
}

function integer(value: string): number {
  if (!/^\d+$/u.test(value)) throw new InvalidArgumentError('Expected a non-negative integer.');
  return Number(value);
}
