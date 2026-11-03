import { runSeedCli } from './run-seed-cli.js';

// Entry point of `pnpm db:seed`. The exit code is set instead of calling
// `process.exit`, so the pool and the output streams close before the process
// ends.
process.exitCode = await runSeedCli({
  stdout: process.stdout,
  stderr: process.stderr,
});
