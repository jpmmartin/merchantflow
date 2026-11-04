/**
 * Path of the webhook receiver below the public base URL, without the
 * provider and the account. It is the route of `StripeWebhookController`
 * under the API prefix (`api/v1`), and the two must stay equal.
 */
export const WEBHOOK_RECEIVER_PATH = '/api/v1/webhooks';

/**
 * The URL a provider delivers an account's events to: the public base URL of
 * the API, the receiver path, the provider code, and the account id, such as
 * `https://example.ngrok-free.app/api/v1/webhooks/stripe/<id>`. `null` when no
 * public base URL is configured. An empty value counts as none: the
 * configuration schema reads it as unset, but `ConfigService.get` then falls
 * back to the empty string that Compose passes in the process environment.
 */
export function webhookEndpointUrl(
  publicBaseUrl: string | undefined,
  account: { readonly id: string; readonly provider: string },
): string | null {
  if (publicBaseUrl === undefined || publicBaseUrl === '') return null;
  return `${publicBaseUrl}${WEBHOOK_RECEIVER_PATH}/${account.provider}/${account.id}`;
}
