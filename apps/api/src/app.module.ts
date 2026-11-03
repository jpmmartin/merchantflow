import { Module } from '@nestjs/common';
import { AppConfigModule } from './modules/config/config.module.js';
import { LoggingModule } from './modules/logging/logging.module.js';
import { HealthModule } from './modules/health/health.module.js';

@Module({
  imports: [AppConfigModule, LoggingModule, HealthModule],
})
export class AppModule {}
