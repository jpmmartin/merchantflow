import type { CurrentPrincipal } from '../application/get-current-principal.service.js';
import type { UserSummary } from '../application/user.js';
import type {
  CurrentPrincipalResponse,
  LoginResponse,
} from './auth.schemas.js';

function toUserPrincipalResponse(
  user: UserSummary,
): Extract<CurrentPrincipalResponse, { type: 'USER' }> {
  return {
    type: 'USER',
    user_id: user.id,
    display_name: user.displayName,
    email: user.email,
    role: user.scope.role,
    merchant_id: user.scope.kind === 'MERCHANT' ? user.scope.merchantId : null,
  };
}

/** The sign-in response: the token once, its expiry, and who signed in. */
export function toLoginResponse(
  token: string,
  expiresAt: Date,
  user: UserSummary,
): LoginResponse {
  return {
    token,
    expires_at: expiresAt.toISOString(),
    principal: toUserPrincipalResponse(user),
  };
}

/** The caller of a request, built field by field. */
export function toCurrentPrincipalResponse(
  current: CurrentPrincipal,
): CurrentPrincipalResponse {
  switch (current.source) {
    case 'USER':
      return toUserPrincipalResponse(current.user);
    case 'API_KEY': {
      const { principal } = current;
      if (principal.source !== 'API_KEY') {
        throw new Error('an API key description needs an API key principal');
      }
      return {
        type: 'API_KEY',
        api_key_id: principal.apiKeyId,
        role: principal.role,
        merchant_id:
          principal.kind === 'MERCHANT' ? principal.merchantId : null,
      };
    }
  }
}
