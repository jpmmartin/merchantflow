import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnv } from './validate-env.js';

// The API runs from `apps/api` under `pnpm dev`, so the repository-root `.env`
// is two levels up; a `.env` in the working directory takes precedence. Real
// environment variables always win over both files.
const ENV_FILE_PATHS = ['.env', '../../.env'];

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ENV_FILE_PATHS,
      validate: validateEnv,
    }),
  ],
})
export class AppConfigModule {}
