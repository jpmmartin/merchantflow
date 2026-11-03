import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ClockModule } from '../clock/clock.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { ApiKeyAuthGuard } from './api/api-key-auth.guard.js';
import { AuthenticateApiKeyService } from './application/authenticate-api-key.service.js';
import { IssueApiKeyService } from './application/issue-api-key.service.js';
import { RevokeApiKeyService } from './application/revoke-api-key.service.js';

/**
 * Owns API keys and authentication. It registers `ApiKeyAuthGuard` for the
 * whole application, so every route of every module requires a key unless it
 * is marked public.
 */
@Module({
  imports: [DatabaseModule, ClockModule],
  providers: [
    IssueApiKeyService,
    RevokeApiKeyService,
    AuthenticateApiKeyService,
    { provide: APP_GUARD, useClass: ApiKeyAuthGuard },
  ],
  exports: [IssueApiKeyService, RevokeApiKeyService],
})
export class AuthModule {}
