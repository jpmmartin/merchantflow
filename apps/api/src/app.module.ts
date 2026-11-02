import { Module } from '@nestjs/common';
import { AppConfigModule } from './modules/config/config.module.js';
import { HealthModule } from './modules/health/health.module.js';

@Module({
  imports: [AppConfigModule, HealthModule],
})
export class AppModule {}
