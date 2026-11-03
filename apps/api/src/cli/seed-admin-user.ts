import { runSeedAdminUserCli } from './run-seed-admin-user-cli.js';

// Second step of `pnpm db:seed`. The exit code is set instead of calling
// `process.exit`, so the pool and the output streams close before the process
// ends.
process.exitCode = await runSeedAdminUserCli({
  stdout: process.stdout,
  stderr: process.stderr,
});
