import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ClockModule } from '../clock/clock.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { ApiKeyAuthGuard } from './api/api-key-auth.guard.js';
import { AuthController } from './api/auth.controller.js';
import { AuthenticateApiKeyService } from './application/authenticate-api-key.service.js';
import { AuthenticateSessionService } from './application/authenticate-session.service.js';
import { CreateUserService } from './application/create-user.service.js';
import { DisableUserService } from './application/disable-user.service.js';
import { FindActivePlatformApiKeyService } from './application/find-active-platform-api-key.service.js';
import { FindApiKeyService } from './application/find-api-key.service.js';
import { FindPlatformUserService } from './application/find-platform-user.service.js';
import { GetCurrentPrincipalService } from './application/get-current-principal.service.js';
import { IssueApiKeyService } from './application/issue-api-key.service.js';
import { ListApiKeysService } from './application/list-api-keys.service.js';
import { ListUsersService } from './application/list-users.service.js';
import { LogInService } from './application/log-in.service.js';
import { LogOutService } from './application/log-out.service.js';
import { RevokeApiKeyService } from './application/revoke-api-key.service.js';

/**
 * Owns API keys, users, sessions, and authentication. It registers
 * `ApiKeyAuthGuard` for the whole application, so every route of every module
 * requires an API key or a session token unless it is marked public.
 */
@Module({
  imports: [DatabaseModule, ClockModule],
  controllers: [AuthController],
  providers: [
    IssueApiKeyService,
    RevokeApiKeyService,
    AuthenticateApiKeyService,
    AuthenticateSessionService,
    FindApiKeyService,
    FindActivePlatformApiKeyService,
    CreateUserService,
    FindPlatformUserService,
    ListUsersService,
    DisableUserService,
    ListApiKeysService,
    LogInService,
    LogOutService,
    GetCurrentPrincipalService,
    { provide: APP_GUARD, useClass: ApiKeyAuthGuard },
  ],
  exports: [
    IssueApiKeyService,
    RevokeApiKeyService,
    FindApiKeyService,
    FindActivePlatformApiKeyService,
    CreateUserService,
    FindPlatformUserService,
    ListUsersService,
    DisableUserService,
    ListApiKeysService,
  ],
})
export class AuthModule {}
