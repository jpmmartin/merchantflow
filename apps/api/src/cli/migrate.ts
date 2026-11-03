import { runMigrateCli } from './run-migrate-cli.js';

// Entry point of `pnpm db:migrate`. The exit code is set instead of calling
// `process.exit`, so the pool and the output streams close before the process
// ends.
process.exitCode = await runMigrateCli({
  stdout: process.stdout,
  stderr: process.stderr,
});
