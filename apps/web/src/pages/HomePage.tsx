import type { CurrentPrincipal } from '../api/auth';
import { roleLabel } from '../components/navigation';

interface HomePageProps {
  readonly principal: CurrentPrincipal;
}

/** Shows who is signed in, as `GET /auth/me` reported it. */
export function HomePage({ principal }: HomePageProps) {
  return (
    <div className="card">
      <div className="card-body">
        <h1 className="h4 card-title">
          {principal.type === 'USER'
            ? `Welcome, ${principal.display_name}`
            : 'Signed in with an API key'}
        </h1>
        <dl className="row mb-0 mt-3">
          {principal.type === 'USER' ? (
            <>
              <dt className="col-sm-3">Email</dt>
              <dd className="col-sm-9">{principal.email}</dd>
              <dt className="col-sm-3">User ID</dt>
              <dd className="col-sm-9">
                <code>{principal.user_id}</code>
              </dd>
            </>
          ) : (
            <>
              <dt className="col-sm-3">API key ID</dt>
              <dd className="col-sm-9">
                <code>{principal.api_key_id}</code>
              </dd>
            </>
          )}
          <dt className="col-sm-3">Role</dt>
          <dd className="col-sm-9">
            {roleLabel(principal.role)} (<code>{principal.role}</code>)
          </dd>
          <dt className="col-sm-3">Merchant</dt>
          <dd className="col-sm-9">
            {principal.merchant_id === null ? (
              'None (platform role)'
            ) : (
              <code>{principal.merchant_id}</code>
            )}
          </dd>
        </dl>
      </div>
    </div>
  );
}
