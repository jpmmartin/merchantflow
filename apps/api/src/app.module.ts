import { Module } from '@nestjs/common';
import { AuthModule } from './modules/auth/auth.module.js';
import { AppConfigModule } from './modules/config/config.module.js';
import { DatabaseModule } from './modules/database/database.module.js';
import { ErrorsModule } from './modules/errors/errors.module.js';
import { LoggingModule } from './modules/logging/logging.module.js';
import { HealthModule } from './modules/health/health.module.js';

@Module({
  imports: [
    AppConfigModule,
    LoggingModule,
    ErrorsModule,
    DatabaseModule,
    HealthModule,
    AuthModule,
  ],
})
export class AppModule {}
