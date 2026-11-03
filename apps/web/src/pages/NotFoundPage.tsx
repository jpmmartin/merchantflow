import { Link } from 'react-router';

/** Shown for a path the app has no screen for. */
export function NotFoundPage({ homePath }: { readonly homePath: string }) {
  return (
    <div className="alert alert-secondary">
      This page does not exist. <Link to={homePath}>Go to the start page</Link>.
    </div>
  );
}
