#!/usr/bin/env node

import { runCli } from './cli.js';
import { exitCodeFor, formatFatalError } from './errors.js';

runCli(process.argv).catch((error) => {
  process.stderr.write(`${formatFatalError(error)}\n`);
  process.exitCode = exitCodeFor(error);
});
