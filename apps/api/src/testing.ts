/**
 * Entry point for test suites outside this package (`@merchantflow/api/testing`).
 * It exposes only the public ways in: the application as the server process
 * creates it, and the development seed that prints the platform administrator
 * key. Both read the environment through the configuration module, which
 * validates it as soon as this module is loaded.
 */
export { createApiApplication } from './bootstrap.js';
export { runSeedCli, type SeedCliOptions } from './cli/run-seed-cli.js';
