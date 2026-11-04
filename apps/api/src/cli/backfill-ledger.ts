import { runBackfillLedgerCli } from './run-backfill-ledger-cli.js';

// Entry point of `pnpm db:backfill-ledger`. The exit code is set instead of
// calling `process.exit`, so the pool and the output streams close before the
// process ends.
process.exitCode = await runBackfillLedgerCli({
  stdout: process.stdout,
  stderr: process.stderr,
});
