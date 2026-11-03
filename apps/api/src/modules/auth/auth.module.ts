import { Module } from '@nestjs/common';
import { ClockModule } from '../clock/clock.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { IssueApiKeyService } from './application/issue-api-key.service.js';
import { RevokeApiKeyService } from './application/revoke-api-key.service.js';

@Module({
  imports: [DatabaseModule, ClockModule],
  providers: [IssueApiKeyService, RevokeApiKeyService],
  exports: [IssueApiKeyService, RevokeApiKeyService],
})
export class AuthModule {}
