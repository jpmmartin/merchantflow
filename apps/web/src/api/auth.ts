import { apiRequest } from './client';

export type Role = 'PLATFORM_ADMIN' | 'MERCHANT_ADMIN' | 'MERCHANT_READ_ONLY';

/** The signed-in user, as `POST /auth/login` and `GET /auth/me` return it. */
export interface UserPrincipal {
  readonly type: 'USER';
  readonly user_id: string;
  readonly display_name: string;
  readonly email: string;
  readonly role: Role;
  readonly merchant_id: string | null;
}

/** An API key caller of `GET /auth/me`. The web app never signs in with one. */
export interface ApiKeyPrincipal {
  readonly type: 'API_KEY';
  readonly api_key_id: string;
  readonly role: Role;
  readonly merchant_id: string | null;
}

export type CurrentPrincipal = UserPrincipal | ApiKeyPrincipal;

export interface LoginResult {
  readonly token: string;
  readonly expires_at: string;
  readonly principal: UserPrincipal;
}

export async function logIn(
  email: string,
  password: string,
): Promise<LoginResult> {
  return (await apiRequest('POST', '/auth/login', {
    body: { email, password },
    authenticated: false,
  })) as LoginResult;
}

export async function logOut(): Promise<void> {
  await apiRequest('POST', '/auth/logout');
}

export async function fetchCurrentPrincipal(): Promise<CurrentPrincipal> {
  return (await apiRequest('GET', '/auth/me')) as CurrentPrincipal;
}
