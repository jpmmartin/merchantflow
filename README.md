# MerchantFlow

MerchantFlow is a payment orchestration reference platform built as a modular monolith with NestJS and PostgreSQL.

> **MerchantFlow is a reference implementation.** It uses synthetic data, processes no real money, and is **not production ready or certified** for any payment standard. Never point it at real payment credentials or real cardholder data.

## Overview

Today the repository contains the runnable foundation only:

- a pnpm workspace with a NestJS API (`apps/api`), a PostgreSQL access package (`packages/database`), a provider-agnostic processor port (`packages/processor-contracts`), a Stripe adapter (`packages/processor-stripe`), and a web frontend (`apps/web`, React, Vite, and Bootstrap 5) with sign-in, merchant management, the users, API keys, and Stripe accounts of each merchant, the payment orders of a merchant user, paid with a card in Stripe's own fields, 3D Secure included, with each order's timeline, and an audit log page (see Web frontend);
- liveness and readiness endpoints, `GET /health/live` and `GET /health/ready`;
- validated environment configuration that stops the API at startup when it is invalid;
- structured JSON logs with a correlation ID on every request;
- one error format for every failure, with a stable `code`, a safe message, and the correlation ID, plus request validation with Zod and an OpenAPI document served outside production (see API conventions);
- a forward-only SQL migration runner (`pnpm db:migrate`);
- database tables for merchants, API keys, users, user sessions, processor accounts, an append-only audit trail, idempotency records, payment intents, payment attempts, refunds, and a ledger, with the constraints enforced by PostgreSQL itself;
- API keys: 256 bits of randomness, only a lookup identifier and a SHA-256 hash stored, and an audit event for each issuance and revocation;
- request authentication: a global guard checks the `Authorization: Bearer <token>` header, an API key or a user session token, against the stored hash on every request, with deny-by-default routing and role checks (see Authentication);
- user sign-in: `POST /api/v1/auth/login` with an email and a password (scrypt hashes only), `POST /api/v1/auth/logout`, and `GET /api/v1/auth/me`;
- merchant endpoints under `/api/v1/merchants`: create, read, list with stable pagination, update, change status, list, issue, and revoke API keys, create, list, and disable merchant users, and connect, list, disable, and choose the default of Stripe test accounts, each with role rules, tenant isolation, and an audit event for each change (see Merchant endpoints);
- payment intent creation, `POST /api/v1/payment-intents`, with a required `Idempotency-Key` and protection against a second intent for the same merchant order (see Payment intents); nothing is charged;
- payment intent retrieval, `GET /api/v1/payment-intents/{id}`, and listing, `GET /api/v1/payment-intents`, newest first with stable pagination and a status filter, both scoped to the merchant of the key (see Payment intents);
- payment confirmation through Stripe in test mode, `POST /api/v1/payment-intents/{id}/confirm`, with a required `Idempotency-Key`, the merchant's default Stripe account, and no database transaction open during the Stripe call; 3D Secure completion, `POST /api/v1/payment-intents/{id}/complete-action`; and the attempt history, `GET /api/v1/payment-intents/{id}/attempts` (see Confirming a payment intent);
- refunds through Stripe in test mode, full or partial, `POST /api/v1/payment-intents/{id}/refunds` with a required `Idempotency-Key`, through the Stripe account that captured the payment, and the refund list, `GET /api/v1/payment-intents/{id}/refunds` (see Refunding a payment intent);
- manual capture: an order created with `capture_mode` `MANUAL` is only authorized when it is paid (`REQUIRES_CAPTURE`, the funds held and not captured), then `POST /api/v1/payment-intents/{id}/capture` captures its whole amount (`SUCCEEDED`) or `POST /api/v1/payment-intents/{id}/void` releases the hold (`CANCELED`), each with a required `Idempotency-Key`; `GET /api/v1/payment-intents/{id}/hold-actions` lists the captures and voids, and `.../hold-actions/{actionId}/refresh` checks one whose outcome is unknown (see Capturing or voiding an authorized payment);
- Stripe webhooks per processor account: `POST /api/v1/webhooks/stripe/{processorAccountId}`, public and authenticated only by the signature, with an inbox of received events; a refund that Stripe finishes or fails later, and a payment left in `REQUIRES_ACTION` or `UNKNOWN`, are brought up to date from Stripe; the webhook of each account is configured automatically in the merchant's own Stripe account or with a pasted signing secret; `POST /api/v1/payment-intents/{id}/refunds/{refundId}/refresh` checks one refund without a webhook; and an optional ngrok service exposes only the webhook route in local work (see Stripe webhooks);
- a double-entry merchant ledger: each successful payment and each successful refund posts one balanced, immutable journal entry in the same transaction that records the success, and `GET /api/v1/merchants/{id}/ledger/balances`, `.../ledger/journal-entries`, and `.../ledger/journal-entries/{journalEntryId}` read the accounts with their balances and the entries (see Ledger);
- an audit log and a payment timeline: `GET /api/v1/audit-events` lists the audit trail newest first with stable pagination and filters by action and time (every event for the platform administrator, only the own merchant's for a merchant user), and `GET /api/v1/payment-intents/{id}/timeline` combines everything that happened to one payment in time order, each step with who did it (see Audit log and payment timeline);
- a development seed, `pnpm db:seed`, that creates the first platform administrator key and the platform administrator user (see Demonstration: two merchants, neither sees the other, and Web frontend);
- linting, formatting, type checking, unit tests, and integration tests against a real PostgreSQL started with Testcontainers, including an HTTP concurrency suite (`tests/concurrency`) that sends 50 simultaneous requests to the listening API and checks that duplicates create one intent;
- a GitHub Actions workflow that runs the same checks.

Automatic recovery of payments, refunds, captures, and voids with an unknown outcome (beyond what a webhook or a check resolves), partial capture, the simulated processor, processor fees, settlements and payouts in the ledger, and every other business capability are planned and do not exist yet.

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) with Docker Compose v2
- [Git](https://git-scm.com/)

Node.js, pnpm, and PostgreSQL are not needed on the host: everything runs in containers.

The setup has been verified on **Docker Desktop only**. The `dev` container mounts the Docker socket so that integration tests can start sibling PostgreSQL containers, and `docker-compose.yml` adds the container's `node` user to the `root` group (`group_add: ['0']`) so it can open that socket. Docker Desktop exposes the socket as `root:root`. On other hosts, such as native Linux, the socket usually belongs to the host's `docker` group, so the group in `group_add` has to be changed to match, or `pnpm test:integration` fails with a permission error on the socket. This mount gives the container control of the local Docker daemon, which is acceptable for local development only.

## Quick start

1. Clone the repository and start the stack. The first build downloads the Node.js and PostgreSQL images.

   ```bash
   git clone <repository-url> merchantflow
   cd merchantflow
   docker compose up -d --build
   ```

2. Install the dependencies inside the `dev` container. They are stored in a Docker volume, not on the host.

   ```bash
   docker compose exec dev pnpm install --frozen-lockfile
   ```

3. Start the API. This command stays in the foreground and restarts on file changes, so run the next steps in a second terminal.

   ```bash
   docker compose exec dev pnpm dev
   ```

4. Check readiness from the host:

   ```bash
   curl -i http://127.0.0.1:3000/health/ready
   ```

   A healthy stack answers `200` with `{"status":"ready"}`. If PostgreSQL is stopped, the answer is `503` with `{"status":"unavailable"}`.

5. Stop everything when finished. Add `--volumes` to also delete the database and the dependency volumes.

   ```bash
   docker compose down
   ```

The API is published on `127.0.0.1:3000`, the web frontend's development server on `127.0.0.1:5173`, and PostgreSQL on `127.0.0.1:5434`, all only on the local machine. If either port is taken, stop the process that uses it before starting the stack.

## Running commands

Two kinds of commands are used:

- `docker compose ...` runs on the host and manages the containers.
- Project commands run inside the `dev` container with `docker compose exec dev <command>`, for example `docker compose exec dev pnpm test`.

## Available commands

Run each of these as `docker compose exec dev pnpm <script>`.

| Script             | What it does                                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------------- |
| `dev`              | Builds the database package and starts the API in watch mode on port 3000                               |
| `dev:web`          | Starts the Vite development server of the web frontend on port 5173 (see Web frontend)                  |
| `build`            | Compiles every package, the web frontend included (type check and `vite build` into `apps/web/dist`)    |
| `test`             | Runs the unit and API tests; they need no database                                                      |
| `test:integration` | Runs the integration tests, the concurrency suite in `tests/concurrency` included; they start PostgreSQL containers through Testcontainers and need Docker |
| `lint`             | Runs ESLint, including type-aware rules                                                                 |
| `typecheck`        | Type-checks every package without emitting files                                                        |
| `format`           | Rewrites files with Prettier                                                                            |
| `format:check`     | Fails if any file is not formatted with Prettier                                                        |
| `db:migrate`       | Builds the project, applies pending SQL migrations to the database in `DATABASE_URL`, and prints status |
| `db:seed`          | Builds the project, creates the development platform administrator key, and creates the platform administrator user; the key and the user's password are each printed once (see Demonstration and Web frontend) |
| `db:backfill-ledger` | Builds the project and posts the missing sale entry of every successful payment, such as those that succeeded before the ledger existed; safe to run again (see Ledger) |

`pnpm db:migrate` is safe to run repeatedly: applied migrations are recorded and never run twice, and concurrent runs are serialized by a database lock. The first run on an empty database creates the tables (`merchants`, `audit_events`, `api_keys`, `idempotency_records`, `payment_intents`, `users`, and `user_sessions`), and later runs report `Nothing is pending.` It empties `apps/api/dist` when it builds, which can interrupt a `pnpm dev` that is restarting at that moment.

## API conventions

Business endpoints live under `/api/v1`; the health endpoints keep their paths, `/health/live` and `/health/ready`. The business endpoints today are the merchant endpoints and payment intent creation and retrieval (see Merchant endpoints and Payment intents).

Every error response has the same body, and its `correlationId` equals the `X-Correlation-Id` response header. `message` is fixed text for each `code`; it never contains parser, framework, or internal details, and a validation error lists the field path and the rule code of each invalid field, never the received value.

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "The request does not match the expected format.",
    "correlationId": "5b0d2c0e-6a63-4d4b-8c1f-3f8f4a0c9d11",
    "issues": [{ "path": ["quantity"], "code": "invalid_type" }]
  }
}
```

| Code                     | Status | Meaning                                                                        |
| ------------------------ | ------ | ------------------------------------------------------------------------------ |
| `VALIDATION_FAILED`      | 400    | Body, query, or route parameters do not match their schema; has `issues`       |
| `MALFORMED_JSON`         | 400    | The body is not valid JSON                                                     |
| `UNAUTHENTICATED`        | 401    | The API key or session token is missing, malformed, unknown, wrong, revoked, or expired, or the user is disabled |
| `INVALID_CREDENTIALS`    | 401    | `POST /auth/login` failed: unknown email, wrong password, or disabled user, never told apart |
| `INSUFFICIENT_ROLE`      | 403    | The API key or user is valid but its role does not allow the operation         |
| `SESSION_REQUIRED`       | 403    | `POST /auth/logout` was called with an API key; it applies only to sessions    |
| `NOT_FOUND`              | 404    | Unknown route, unsupported method, or a resource the caller cannot see         |
| `MERCHANT_TRANSITION_NOT_ALLOWED` | 409 | The merchant's status cannot change to the requested one (including to itself) |
| `MERCHANT_STATUS_CONFLICT` | 409  | Another request changed the merchant's status first; nothing was changed       |
| `IDEMPOTENCY_KEY_MISSING` | 400   | A command was sent without its required `Idempotency-Key` header               |
| `IDEMPOTENCY_KEY_INVALID` | 400   | The `Idempotency-Key` header is not 1 to 255 visible ASCII characters          |
| `MERCHANT_NOT_ACTIVE`    | 403    | Payment commands need an `ACTIVE` merchant; nothing was stored                 |
| `IDEMPOTENCY_KEY_REUSED` | 409    | The key was already used for a different request                               |
| `OPERATION_IN_PROGRESS`  | 409    | The same request under the key has not finished; has `Retry-After`             |
| `DUPLICATE_MERCHANT_REFERENCE` | 409 | The merchant already has a payment intent for this `merchant_reference`    |
| `MERCHANT_CURRENCY_MISMATCH` | 422 | The currency is not the merchant's default currency                          |
| `OPERATION_TIMEOUT`      | 503    | The request waited too long for another one; nothing was stored, retry it; has `Retry-After` |
| `SERVICE_BUSY`           | 503    | No database connection became free within 2 seconds; nothing was changed, retry the same request; has `Retry-After` |
| `REQUEST_REJECTED`       | 4xx    | Any other client error, with its own status                                    |
| `PAYLOAD_TOO_LARGE`      | 413    | The body exceeds the parser's default limit                                    |
| `UNSUPPORTED_MEDIA_TYPE` | 415    | The body encoding is not supported                                             |
| `INTERNAL_ERROR`         | 500    | An unexpected failure; the cause is only in the server log                     |

The `/health/ready` answer is the exception: its `503` body stays `{"status":"unavailable"}`, because probes read the status.

Outside production (`NODE_ENV` other than `production`) the API serves its OpenAPI document at `GET /docs/openapi.json` and an interactive UI at `GET /docs`. In production neither exists.

## Merchant endpoints

All of them need an API key or a session token (see Authentication) and use `snake_case` fields. Merchants start in `DRAFT`; the allowed status changes are `DRAFT` to `ACTIVE`, `ACTIVE` to `SUSPENDED`, and `SUSPENDED` to `ACTIVE`.

| Endpoint                                                | `PLATFORM_ADMIN` | `MERCHANT_ADMIN`            | `MERCHANT_READ_ONLY` |
| ------------------------------------------------------- | ---------------- | --------------------------- | -------------------- |
| `POST /api/v1/merchants`                                | creates          | 403                         | 403                  |
| `GET /api/v1/merchants`                                 | lists all        | lists its own merchant      | lists its own        |
| `GET /api/v1/merchants/{id}`                            | any merchant     | its own merchant            | its own merchant     |
| `PATCH /api/v1/merchants/{id}`                          | five profile fields | `display_name`, `industry` of its own | 403         |
| `POST /api/v1/merchants/{id}/status`                    | changes status   | 403                         | 403                  |
| `GET /api/v1/merchants/{id}/api-keys`                   | lists the keys   | of its own merchant         | of its own merchant  |
| `POST /api/v1/merchants/{id}/api-keys`                  | issues a key     | issues a key of its own     | 403                  |
| `POST /api/v1/merchants/{id}/api-keys/{apiKeyId}/revoke` | revokes a key   | revokes a key of its own    | 403                  |
| `POST /api/v1/merchants/{id}/users`                     | creates a user   | creates a user of its own   | 403                  |
| `GET /api/v1/merchants/{id}/users`                      | lists the users  | of its own merchant         | of its own merchant  |
| `POST /api/v1/merchants/{id}/users/{userId}/disable`    | disables a user  | disables a user of its own  | 403                  |
| `POST /api/v1/merchants/{id}/processor-accounts`        | connects an account | connects one of its own  | 403                  |
| `GET /api/v1/merchants/{id}/processor-accounts`         | lists the accounts | of its own merchant       | of its own merchant  |
| `POST /api/v1/merchants/{id}/processor-accounts/{processorAccountId}/disable` | disables an account | of its own | 403      |
| `POST /api/v1/merchants/{id}/processor-accounts/{processorAccountId}/default` | sets the default | of its own   | 403                  |

- A merchant key that names any merchant other than its own gets `404 NOT_FOUND` before any role check, and the answer is the same as for a merchant that does not exist. For its own merchant, a forbidden operation, field, or status change is `403 INSUFFICIENT_ROLE` and nothing changes, also when the merchant is suspended. A merchant administrator may still edit `display_name` and `industry` while its merchant is suspended.
- A platform administrator updates `legal_name`, `display_name`, `business_type`, `industry`, and `country_code`. `default_currency` is fixed when the merchant is created, and the status changes only through `POST .../status`.
- `default_currency` accepts only a supported currency, which is `USD` for now (the OpenAPI document lists the accepted codes). Any other code, including a well-formed one such as `EUR`, is a `400 VALIDATION_FAILED` with an issue on `default_currency` and the rule code `invalid_value`, and nothing is stored.
- Request bodies and query strings are strict: an unknown field is a `400 VALIDATION_FAILED`.
- Creating a merchant does not issue a key. `POST .../api-keys` with `{"role": "MERCHANT_ADMIN"}` or `{"role": "MERCHANT_READ_ONLY"}` returns the key once, with `Cache-Control: no-store`; it is stored only as a hash and cannot be retrieved again. A revoked key stops working with its next request. A key always has a merchant role: no route issues a `PLATFORM_ADMIN` key.
- `GET .../api-keys` returns `{"data": [...]}` with every key of the merchant, revoked ones included, oldest first: `id`, `merchant_id`, `role`, `created_at`, and `revoked_at` (`null` while active). It never returns the key, its secret, its hash, or its lookup identifier.
- `POST .../users` with `{"email": "...", "display_name": "..."}` creates an enabled user with the role `MERCHANT_ADMIN` (there is no role choice yet) and returns it with `initial_password`, a password of 24 characters generated by the server, once and with `Cache-Control: no-store`. The email is stored in lower case and is unique across the platform: a taken email is `409 USER_EMAIL_TAKEN`, which reveals that the address is registered. There is no password change yet, so the user keeps that password.
- `GET .../users` returns `{"data": [...]}` with every user of the merchant, disabled ones included, oldest first, and never a password or its hash.
- `POST .../users/{userId}/disable` disables the user and revokes all its sessions in the same transaction, so its token gets `401` at the next request and it can no longer sign in. A signed-in user cannot disable itself (`409 USER_SELF_DISABLE_NOT_ALLOWED`). Disabling a disabled user succeeds and changes nothing. There is no re-enable yet.
- `GET /api/v1/merchants?limit=20&cursor=...` returns `{"data": [...], "next_cursor": "..."}` ordered by creation time and then id. `limit` is 1 to 100 (default 20). Pass `next_cursor` back unchanged as `cursor`; it is `null` on the last page. An invalid cursor is a `400`. A walk over the pages never repeats a merchant, and never skips one that existed when it began.
- Every change writes one audit event in the same transaction, naming the API key or user that made it and the request's correlation ID (`USER_CREATED` and `USER_DISABLED` for users, with no password; `PROCESSOR_ACCOUNT_CONNECTED`, `PROCESSOR_ACCOUNT_DISABLED`, and `PROCESSOR_ACCOUNT_DEFAULT_CHANGED` for processor accounts, with no key). Updates record the previous and new values of the changed fields.
- The OpenAPI document (outside production) lists each endpoint with its roles, schemas, error responses, and the `bearer` security scheme.

The first platform administrator key cannot be created through the API; `pnpm db:seed` creates it (see Demonstration).

## Processor accounts

A merchant collects payments through a processor account. For now the only provider is Stripe, in **test mode only**. New payments use the merchant's enabled default account (see Confirming a payment intent).

- `POST .../processor-accounts` with `{"provider": "stripe", "display_name": "...", "credentials": {"secret_key": "sk_test_...", "publishable_key": "pk_test_..."}}` validates the keys and stores the account (`201`, `Cache-Control: no-store`):
  - a live key (`sk_live_`, `rk_live_`, `pk_live_`) is `422 PROCESSOR_LIVE_CREDENTIALS_REJECTED` before any call to Stripe; a key of another format is `422 PROCESSOR_CREDENTIALS_INVALID`;
  - the API then makes two reads with the secret key, `GET /v1/account` (which gives the `acct_` ID) and `GET /v1/balance` (whose `livemode` must be `false`). A key Stripe refuses is `422 PROCESSOR_CREDENTIALS_INVALID`; Stripe unreachable is `503 PROCESSOR_UNAVAILABLE`. No answer repeats a key or a Stripe message;
  - the publishable key is checked for format and mode only: Stripe offers no read that tells which account it belongs to, so use the publishable key of the same Stripe account;
  - the same Stripe account connected twice to a merchant while enabled is `409 PROCESSOR_ACCOUNT_ALREADY_CONNECTED`;
  - without `CREDENTIALS_MASTER_KEY` (see Configuration) the answer is `503 CREDENTIALS_KEY_NOT_CONFIGURED`.
- The secret key is stored encrypted with AES-256-GCM under the master key and is never returned. Responses carry `id`, `merchant_id`, `provider`, `display_name`, `provider_account_id`, `publishable_key`, `secret_key_hint` (its last four characters), `enabled`, `is_default`, `created_at`, and `updated_at`.
- The first account of a merchant, or any account connected while it has no default, becomes the default. `POST .../{processorAccountId}/default` makes another enabled account the default; a disabled one is `409 PROCESSOR_ACCOUNT_DISABLED`.
- `POST .../{processorAccountId}/disable` disables an account. Disabling the default leaves the merchant with **no default** until one is chosen; no other account is picked for it. There is no re-enable; connect the account again instead.
- `GET .../processor-accounts` returns `{"data": [...]}` with every account, disabled ones included, oldest first.

To try it, use the test keys of your own Stripe sandbox (Dashboard, Developers, API keys, with test mode on).

## Payment intents

A payment intent is a merchant's intention to collect an amount. Creating one charges nothing; confirming it charges it (see Confirming a payment intent).

`POST /api/v1/payment-intents` needs a `MERCHANT_ADMIN` key of an `ACTIVE` merchant and an `Idempotency-Key` header. The intent always belongs to the merchant of the key.

```bash
curl -sS -w '\nHTTP %{http_code}\n' -X POST http://127.0.0.1:3000/api/v1/payment-intents \
  -H "Authorization: Bearer $KEY_A" -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: order-1001-attempt-1' \
  -d '{"amount_minor":"1000","currency":"USD","merchant_reference":"order-1001"}'
```

The answer is `201` with `id`, `merchant_id`, `amount_minor`, `currency`, `merchant_reference`, `capture_mode`, `status` (`CREATED`), `created_at`, and `updated_at`.

- `amount_minor` is the amount in minor units as an integer string greater than zero, for example `"1000"` for 10.00 USD, up to `"9223372036854775807"`. It is never read as a JSON number: a number, a sign, a decimal point, spaces, or leading zeros are a `400 VALIDATION_FAILED` whose issue names the reason (`invalid_type`, `empty`, `invalid_format`, `leading_zero`, `out_of_range`, or `not_positive`).
- `currency` must be a supported currency (`USD` for now) and the merchant's `default_currency`; a supported currency that differs is `422 MERCHANT_CURRENCY_MISMATCH`.
- `merchant_reference` is the merchant's own order identifier: 1 to 128 visible ASCII characters, case-sensitive. A merchant has at most one intent per reference, whatever key created it: a new key with a taken reference is `409 DUPLICATE_MERCHANT_REFERENCE`.
- `capture_mode` is optional: `AUTOMATIC` (the default) captures a successful payment at once; `MANUAL` only authorizes it, and the merchant captures or voids it afterwards (see Capturing or voiding an authorized payment). It never changes. Answers stored before capture modes existed replay without the field.
- `Idempotency-Key` is 1 to 255 visible ASCII characters (no spaces), scoped by merchant. Use a new key for each new intent and the same key when retrying the same request.

| Request under a key                            | Answer                                                        |
| ---------------------------------------------- | ------------------------------------------------------------- |
| First use                                      | Creates the intent: `201`, stored under the key               |
| Same key, same request, after it completed     | The stored `201` and body, byte for byte; nothing is written  |
| Same key, same request, still running          | `409 OPERATION_IN_PROGRESS` with `Retry-After`                |
| Same key, different request                    | `409 IDEMPOTENCY_KEY_REUSED`                                  |
| Waited more than 2 seconds for another request | `503 OPERATION_TIMEOUT` with `Retry-After`; send it again     |
| No database connection free within 2 seconds  | `503 SERVICE_BUSY` with `Retry-After`; send it again          |

"Same request" compares the validated fields, so key order and whitespace in the JSON do not matter. Only a created intent is stored under the key. A refused request (validation, role, a `DRAFT` or `SUSPENDED` merchant, a currency mismatch, a duplicate reference, a timeout) stores nothing, so the key stays free: the same request gets the same answer while the cause lasts, and succeeds under the same key once the cause is gone, for example after the merchant is reactivated. A replay of a created intent returns its stored response even if the merchant was suspended afterwards.

`MERCHANT_READ_ONLY` and `PLATFORM_ADMIN` keys get `403 INSUFFICIENT_ROLE`. Each creation writes one `PAYMENT_INTENT_CREATED` audit event in the same transaction; a replay or a refused request writes none.

### Reading a payment intent

`GET /api/v1/payment-intents/{id}` returns one intent of the merchant of the key, for `MERCHANT_ADMIN` and `MERCHANT_READ_ONLY` keys.

```bash
curl -sS -w '\nHTTP %{http_code}\n' http://127.0.0.1:3000/api/v1/payment-intents/<intent id> \
  -H "Authorization: Bearer $KEY_A"
```

The answer is `200` with the same body as the create response, and `amount_minor` is an integer string, exact up to `"9223372036854775807"`.

- An intent of another merchant and an intent that does not exist are the same `404 NOT_FOUND`, with the same body apart from the correlation ID. The merchant always comes from the key, never from the path, a header, or a query parameter.
- An `id` that is not a UUID is `400 VALIDATION_FAILED`, whichever merchant asks.
- A `PLATFORM_ADMIN` key gets `403 INSUFFICIENT_ROLE` for every id, whether or not the intent exists: platform roles have no access to payments yet.
- A `DRAFT` or `SUSPENDED` merchant can still read its intents: a read moves no money, and a suspended merchant needs to see what it created. Only payment commands require an `ACTIVE` merchant.
- A stored intent that this version cannot represent, such as one in a currency the application does not support, is reported as `500 INTERNAL_ERROR` and logged. It is never answered as `404` and never altered.
- A read writes no audit event and touches no idempotency record.

### Listing payment intents

`GET /api/v1/payment-intents?limit=20&cursor=...&status=...` returns `{"data": [...], "next_cursor": "..."}` with the intents of the merchant of the key, for `MERCHANT_ADMIN` and `MERCHANT_READ_ONLY` keys.

```bash
curl -sS -w '\nHTTP %{http_code}\n' 'http://127.0.0.1:3000/api/v1/payment-intents?limit=2&status=CREATED' \
  -H "Authorization: Bearer $KEY_A"
```

- The intents are ordered newest first, by creation time and then id. Each item has the same body as `GET /api/v1/payment-intents/{id}`.
- `limit` is 1 to 100 (default 20). Pass `next_cursor` back unchanged as `cursor`, with the same `status`; it is `null` on the last page. An invalid cursor is a `400`. A walk over the pages never repeats an intent, and never skips one that existed when it began.
- `status` keeps only the intents in that status: `CREATED`, `PROCESSING`, `REQUIRES_ACTION`, `SUCCEEDED`, `FAILED`, `UNKNOWN`, `PARTIALLY_REFUNDED`, or `REFUNDED` (the OpenAPI document lists them). Any other value, a lower-case one included, is a `400 VALIDATION_FAILED`.
- The merchant always comes from the key: a `merchant_id` or any other unknown query parameter is a `400`, and a header naming another merchant is ignored. A `PLATFORM_ADMIN` key or user gets `403 INSUFFICIENT_ROLE`. A `DRAFT` or `SUSPENDED` merchant can still list its intents. A list writes no audit event.

### Confirming a payment intent

`POST /api/v1/payment-intents/{id}/confirm` charges a `CREATED` intent once through Stripe, in test mode. It needs a `MERCHANT_ADMIN` key or user of an `ACTIVE` merchant and an `Idempotency-Key` header.

```bash
curl -sS -w '\nHTTP %{http_code}\n' -X POST http://127.0.0.1:3000/api/v1/payment-intents/<intent id>/confirm \
  -H "Authorization: Bearer $KEY_A" -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: order-1001-pay-1' \
  -d '{"payment_method":"pm_card_visa","processor_account_id":"<default account id>"}'
```

- `payment_method` is a payment method token created in the browser by Stripe.js with the account's publishable key (`pm_...`); card data never reaches the API, and a card number in this field is a `400`. Stripe's test tokens such as `pm_card_visa` also work from a server.
- `processor_account_id` is the account whose publishable key created the payment method, so the publishable and secret keys always belong to one Stripe account. It must be the merchant's account (`422 PROCESSOR_ACCOUNT_NOT_FOUND` otherwise, also for another merchant's account), enabled (`409 PROCESSOR_ACCOUNT_DISABLED`), and its default (`409 PROCESSOR_ACCOUNT_NOT_DEFAULT`).
- The API creates and confirms one Stripe PaymentIntent, for cards only, with automatic capture, or with `capture_method: manual` for a `MANUAL` intent, with the attempt's `operation_id` as Stripe's idempotency key and `merchant_id`, `payment_intent_id`, and `payment_attempt_id` as its metadata.
- The answer is `{"payment_intent": {...}, "attempt": {...}, "next_action": ...}` with `Cache-Control: no-store`:

| Outcome at Stripe | HTTP | Attempt | Intent | Stored under the key |
| --- | --- | --- | --- | --- |
| Captured (`AUTOMATIC`) | `200` | `SUCCEEDED` | `SUCCEEDED` | Yes |
| Authorized, funds held (`MANUAL`) | `200` | `AUTHORIZED` | `REQUIRES_CAPTURE`; nothing is posted to the ledger | Yes |
| Declined | `200` | `DECLINED`, with `decline_code` | `CREATED`, or `FAILED` at the third unsuccessful attempt | Yes |
| Refused before execution (for example an invalid payment method) | `200` | `FAILED`, with `error_category` | `CREATED`, or `FAILED` at the third unsuccessful attempt | Yes |
| 3D Secure required | `200` | `REQUIRES_ACTION` | `REQUIRES_ACTION` | No; `next_action.client_secret` is for Stripe.js only |
| Timeout, connection error, Stripe server error, or an unproven status | `202` | `UNKNOWN` | `UNKNOWN` | No |

- The same key with the same request returns the stored answer byte for byte, also after the merchant was suspended, and never creates a second Stripe PaymentIntent. While the attempt is `REQUIRES_ACTION` or `UNKNOWN`, or still running, the same key gets `409 OPERATION_IN_PROGRESS`. The same key with a different request is `409 IDEMPOTENCY_KEY_REUSED`. A refused request stores nothing.
- One attempt at a time: a new key while an attempt is executing or waits for 3D Secure is `409 PAYMENT_ATTEMPT_IN_PROGRESS`; while an outcome is unknown it is `409 PAYMENT_OUTCOME_UNKNOWN` (do not pay again). A `SUCCEEDED`, `FAILED`, refunded, `REQUIRES_CAPTURE`, or `CANCELED` intent is `409 PAYMENT_INTENT_NOT_CONFIRMABLE`.
- Another merchant's intent is `404 NOT_FOUND`; `MERCHANT_READ_ONLY` gets `403 INSUFFICIENT_ROLE`, and so does a platform key for every id. A `DRAFT` or `SUSPENDED` merchant is `403 MERCHANT_NOT_ACTIVE`.
- Each applied result writes one `PAYMENT_INTENT_CONFIRMED` audit event. The client secret never reaches a log line, an audit event, an error, or the database.

### Completing 3D Secure

After Stripe.js `handleNextAction` ran the challenge in the browser, `POST /api/v1/payment-intents/{id}/complete-action` (`MERCHANT_ADMIN`, no body) reads the PaymentIntent from Stripe and applies the result: `SUCCEEDED` (or, for a `MANUAL` intent, `AUTHORIZED` with the intent `REQUIRES_CAPTURE`), or `DECLINED` when authentication failed or the card was declined (back to `CREATED`, or `FAILED` at the third), or `UNKNOWN` (`202`) when Stripe's status does not establish the outcome. A conclusive result also becomes the stored answer of the confirmation's key, and writes one `PAYMENT_INTENT_ACTION_COMPLETED` audit event. It is safe to call more than once: while the payment still requires action nothing changes and `next_action.client_secret` is returned again; after a result was applied it is `409 PAYMENT_ACTION_NOT_PENDING`. Stripe unreachable is `503 PROCESSOR_LOOKUP_UNAVAILABLE` and changes nothing.

### Attempt history

`GET /api/v1/payment-intents/{id}/attempts` (`MERCHANT_ADMIN` and `MERCHANT_READ_ONLY`) returns `{"payment_intent_id", "merchant_id", "data": [...]}` with every attempt of the intent, oldest first: `id`, `processor_account_id`, `status` (`EXECUTING`, `REQUIRES_ACTION`, `SUCCEEDED`, `DECLINED`, `FAILED`, `UNKNOWN`, or, for a `MANUAL` intent, `AUTHORIZED` and `CANCELED`; `SUCCEEDED` always means captured), `provider_transaction_id` (the Stripe `pi_` ID), `decline_code`, `error_category`, `created_at`, and `updated_at`. Another merchant's intent is `404`.

To find a payment in Stripe, open the Dashboard of the merchant's sandbox, go to **Payments** (test mode), and search for the attempt's `pi_` ID; its metadata holds the MerchantFlow IDs.

### Refunding a payment intent

`POST /api/v1/payment-intents/{id}/refunds` needs a `MERCHANT_ADMIN` key or user of an `ACTIVE` merchant and an `Idempotency-Key` header. The body is `{"amount_minor": "<integer string>"}` in minor units of the intent's currency, parsed like `amount_minor` at creation (never as a JSON number). Only a `SUCCEEDED` or `PARTIALLY_REFUNDED` intent can be refunded (`409 PAYMENT_INTENT_NOT_REFUNDABLE` otherwise): a `MANUAL` payment is refundable only once it is captured, and an authorized one is voided instead.

```bash
curl -sS -w '\nHTTP %{http_code}\n' -X POST http://127.0.0.1:3000/api/v1/payment-intents/$INTENT_ID/refunds \
  -H "Authorization: Bearer $KEY_A" -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: order-1001-refund-1' -d '{"amount_minor":"500"}'
```

- **Refundable amount:** the captured amount minus every refund that succeeded or is still executing, pending, or unknown. A larger amount is `409 REFUND_AMOUNT_EXCEEDS_REFUNDABLE`, decided before Stripe is called. Each refund locks the intent's row while it checks and reserves its amount, so concurrent refunds can never add up to more than the captured amount, and PostgreSQL refuses such a row too.
- **Account:** the refund goes through the Stripe account of the payment's successful attempt, even if that account is no longer the default or is disabled.
- **Stripe call:** `POST /v1/refunds` with the PaymentIntent and the amount, with no database transaction open, the refund's operation ID as Stripe's idempotency key, and the merchant, intent, and refund IDs as metadata.

| Stripe outcome | Answer | Refund | Intent | Ledger | Stored under the key |
| -------------- | ------ | ------ | ------ | ------ | -------------------- |
| Succeeded | `201` | `SUCCEEDED` | `PARTIALLY_REFUNDED`, or `REFUNDED` once the refunds add up to the captured amount | One entry: debit `4100` Refunds, credit `1100` | Yes |
| Pending | `201` | `PENDING`; its amount stays reserved | Unchanged | Nothing | Yes |
| Failed | `201` | `FAILED`; its amount is released | Unchanged | Nothing | Yes |
| Timeout or ambiguous answer | `202` | `UNKNOWN`; its amount stays reserved | Unchanged | Nothing | No: the key gets `409 OPERATION_IN_PROGRESS`, and no new refund of the intent is accepted (`409 REFUND_OUTCOME_UNKNOWN`) |

The answer is `{"refund": {...}, "payment_intent": {...}}`: the refund (`id`, `payment_attempt_id`, `processor_account_id`, `amount_minor`, `currency`, `status`, `provider_refund_id` such as Stripe's `re_` ID, `failure_code`, `error_category`, times) and the intent with `refunded_amount_minor` and `refundable_amount_minor`. The same key with the same request returns the stored answer byte for byte and never sends a second refund; the same key with another amount is `409 IDEMPOTENCY_KEY_REUSED`; a refused request stores nothing. Each applied refund writes one `PAYMENT_REFUND_APPLIED` audit event.

`GET /api/v1/payment-intents/{id}/refunds` (`MERCHANT_ADMIN` and `MERCHANT_READ_ONLY`) returns the intent's `captured_amount_minor`, `refunded_amount_minor`, `pending_amount_minor`, and `refundable_amount_minor` as integer strings, and its refunds oldest first in `data`. Another merchant's intent is `404` on both routes. In Stripe, the refunds appear on the payment's page in the Dashboard.

### Capturing or voiding an authorized payment

A `MANUAL` intent that Stripe authorized is `REQUIRES_CAPTURE`: the funds are held on the customer's card and nothing is captured or posted to the ledger. Stripe releases an uncaptured card authorization after seven days by default.

```bash
curl -sS -w '\nHTTP %{http_code}\n' -X POST http://127.0.0.1:3000/api/v1/payment-intents/$INTENT_ID/capture \
  -H "Authorization: Bearer $KEY_A" -H 'Idempotency-Key: order-1001-capture-1'
```

- `POST /api/v1/payment-intents/{id}/capture` captures the whole amount; `POST /api/v1/payment-intents/{id}/void` releases the hold. No body; a `MANUAL` intent in `REQUIRES_CAPTURE` only (`409 PAYMENT_INTENT_NOT_CAPTURABLE` or `409 PAYMENT_INTENT_NOT_VOIDABLE` otherwise, including every `AUTOMATIC` payment). `MERCHANT_ADMIN` only; a capture also needs an `ACTIVE` merchant, while a void, which moves no money, does not.
- The call goes through the Stripe account that authorized the payment (`paymentIntents.capture` with `amount_to_capture`, or `paymentIntents.cancel`), with no database transaction open and the action's operation ID as Stripe's idempotency key.
- Capture and void of one intent exclude each other, also when they are sent at the same time: the second gets `409 AUTHORIZATION_ACTION_IN_PROGRESS` while the first runs, and `409 PAYMENT_INTENT_NOT_CAPTURABLE` or `NOT_VOIDABLE` once it succeeded. PostgreSQL refuses a second capture or void of an intent too.
- Capture and void share one idempotency scope: the same key and the same action replay the stored answer byte for byte; the same key for the other action, or another intent, is `409 IDEMPOTENCY_KEY_REUSED`.

| Stripe outcome | Answer | Action | Intent and attempt | Ledger | Stored under the key |
| --- | --- | --- | --- | --- | --- |
| Captured | `200` | `CAPTURE` `SUCCEEDED` | `SUCCEEDED` | One sale entry, debit `1100`, credit `4000` | Yes |
| Voided | `200` | `VOID` `SUCCEEDED` | `CANCELED` (final) | Nothing | Yes |
| Refused by Stripe (for example an expired authorization) | `200` | `FAILED`, with `failure_code` | Unchanged, `REQUIRES_CAPTURE` | Nothing | Yes |
| Timeout or ambiguous answer | `202` | `UNKNOWN` | Unchanged | Nothing | No: the key gets `409 OPERATION_IN_PROGRESS`, and no new capture or void is accepted (`409 AUTHORIZATION_ACTION_OUTCOME_UNKNOWN`) |

The answer is `{"authorization_action": {...}, "payment_intent": {...}, "attempt": {...}}` with `Cache-Control: no-store`. Each applied capture or void writes one `PAYMENT_AUTHORIZATION_ACTION_APPLIED` audit event.

`GET /api/v1/payment-intents/{id}/hold-actions` (`MERCHANT_ADMIN` and `MERCHANT_READ_ONLY`) returns `{"payment_intent_id", "merchant_id", "data": [...]}` with each capture and void, oldest first: `id`, `action`, `amount_minor`, `currency`, `status`, `failure_code`, `error_category`, the attempt and account, and times.

`POST /api/v1/payment-intents/{id}/hold-actions/{actionId}/refresh` (`MERCHANT_ADMIN`) resolves an `UNKNOWN` capture or void from Stripe's PaymentIntent, with the same rules as the webhook: captured (for a capture) or canceled (for a void) makes it `SUCCEEDED` and moves the intent; a PaymentIntent that still holds its funds proves the request never took effect, so the action becomes `FAILED` (`not_executed`) and a new capture or void can be sent; the other final state makes it `FAILED` (`payment_already_final`). Anything else changes nothing. It is safe to repeat; `change` says what happened (`CAPTURE_SUCCEEDED`, `CAPTURE_FAILED`, `VOID_SUCCEEDED`, `VOID_FAILED`, or `null`). A resolution writes `PAYMENT_AUTHORIZATION_ACTION_RESOLVED` and makes the original key replay the final answer. In Stripe, the payment shows as uncaptured, then succeeded or canceled.

## Stripe webhooks

Stripe tells each merchant's account about payments and refunds that end after MerchantFlow's own call, such as a refund that stays `pending` for a while or a refund that Stripe reports as succeeded and fails later. Each processor account has **its own** webhook endpoint in the merchant's own Stripe account, signed with **its own** secret.

### Configuring the webhook of an account

The endpoint URL of an account is `<PUBLIC_API_BASE_URL>/api/v1/webhooks/stripe/<processor account id>`. `PUBLIC_API_BASE_URL` comes from the configuration (see Configuration); in local work it is your ngrok dev domain (see Local delivery with ngrok).

All routes are below `/api/v1/merchants/{id}/processor-accounts/{processorAccountId}/webhook`, for `PLATFORM_ADMIN` (any merchant) and `MERCHANT_ADMIN` (its own); `MERCHANT_READ_ONLY` can read; another merchant is `404`.

- `GET .../webhook`: `endpoint_url` (`null` without a public base URL), `configured`, `mode` (`AUTOMATIC` or `MANUAL`), `signing_secret_hint` (last four characters), `webhook_endpoint_id` (Stripe's `we_` ID when MerchantFlow created it), and `configured_at`. No answer ever contains the signing secret.
- `POST .../webhook` with `{"mode": "AUTOMATIC"}` creates the endpoint in the merchant's Stripe account with the account's secret key, for the URL above, the events `payment_intent.succeeded`, `payment_intent.payment_failed`, `payment_intent.amount_capturable_updated`, `payment_intent.canceled`, `refund.updated`, and `refund.failed`, and the API version of the pinned Stripe SDK, and stores the signing secret that Stripe returns only at creation. Without a public base URL the answer is `503 PUBLIC_BASE_URL_NOT_CONFIGURED`; Stripe refusing the key is `422 PROCESSOR_CREDENTIALS_INVALID`, refusing the endpoint `422 WEBHOOK_ENDPOINT_REJECTED`, and not answering `503 WEBHOOK_PROVIDER_UNAVAILABLE`.
- `POST .../webhook` with `{"mode": "MANUAL", "signing_secret": "whsec_..."}` stores the secret of an endpoint you created yourself in the Stripe Dashboard (with the URL and the six events above). Only `whsec_` secrets are accepted.
- An endpoint created before manual capture existed receives only its first four event types. **Replace with a new Stripe endpoint** in the webhook panel (or `POST .../webhook` with `{"mode": "AUTOMATIC"}` again) creates one with all six and deletes the old one; for a manual endpoint, add the two `payment_intent` types in the Stripe Dashboard.
- Either replaces the previous configuration. An endpoint MerchantFlow created before is then deleted in Stripe; `previous_endpoint` says `DELETED`, `NONE`, or `NOT_DELETED` (Stripe did not answer; delete it in the Dashboard, its deliveries are refused anyway).
- `POST .../webhook/remove` deletes the endpoint MerchantFlow created in Stripe (one that no longer exists counts as deleted) and clears the secret; later deliveries are refused.
- `GET .../webhook/events`: the latest 20 events received for the account, newest first, with `event_type`, `object_id`, `received_at`, `outcome`, `detail`, and `attempts`.

The signing secret is stored encrypted with AES-256-GCM under `CREDENTIALS_MASTER_KEY`, bound to its account, and is never logged or returned. Each change writes a `PROCESSOR_ACCOUNT_WEBHOOK_CONFIGURED` or `PROCESSOR_ACCOUNT_WEBHOOK_REMOVED` audit event without the secret.

### Receiving events

`POST /api/v1/webhooks/stripe/{processorAccountId}` is public: Stripe sends no API key, so the `Stripe-Signature` header, verified on the raw body with the account's secret and Stripe's default tolerance of 300 seconds, is the only authentication. The raw body is kept for this route only; every other route parses JSON as before.

- An unknown account, a disabled account, an account without a secret, a missing or bad signature, and a live-mode event all get the same `400 WEBHOOK_REJECTED`.
- A verified event is stored first in the inbox (`processor_events`), unique per account and Stripe event ID, with its type, object, reception time, number of runs, outcome, and processing time. No payload, signature, or secret is stored.
- **Redelivery rule:** an event already `PROCESSED` or `IGNORED` is acknowledged again with `200` and changes nothing. An event whose processing `FAILED` (Stripe unreachable, or the payment or refund's own request still running) answers `503 WEBHOOK_PROCESSING_FAILED`, so Stripe delivers it again, and it is processed again then.
- **Processing:** the event is only a trigger. The refund or payment it names is read from Stripe (at most 5 seconds, no retry) and applied with the same conditional updates and transition rules as the API, so a late, repeated, or out-of-order event cannot move a status backwards. A delivery is answered within about six seconds.
  - `refund.updated` and `refund.failed`: a `PENDING` or `UNKNOWN` refund becomes `SUCCEEDED` (the intent becomes `PARTIALLY_REFUNDED` or `REFUNDED`, and the refund entry is posted) or `FAILED` (its amount can be refunded again). A refund is matched by its `re_` ID or, if it never learned it, by the `refund_id` metadata MerchantFlow sent.
  - `payment_intent.succeeded`, `payment_intent.payment_failed`, `payment_intent.amount_capturable_updated`, and `payment_intent.canceled`: a payment in `REQUIRES_ACTION` or `UNKNOWN` is resolved as `complete-action` does (a `MANUAL` one becomes `REQUIRES_CAPTURE` when Stripe authorized it), and its confirmation's `Idempotency-Key` then replays the final answer; otherwise a capture or void of the payment whose outcome is `UNKNOWN` is resolved as its check does. A payment is matched by its `pi_` ID or by the `payment_attempt_id` metadata. An event about a capture or void made outside MerchantFlow, or an authorization that expired, is recorded and changes nothing.
  - Other types, and objects MerchantFlow did not create, are recorded as `IGNORED`.
- Changes made by a webhook are audited with the actor `SYSTEM` / `processor-webhook`.

### A refund that fails after it succeeded

When Stripe fails a refund it had reported as succeeded (`refund.failed`), the refund becomes `FAILED`, a compensating ledger entry reverses its posting (debit `1100`, credit `4100`, source `PAYMENT_REFUND_REVERSAL` with the refund's ID, posted once), the intent moves back to `PARTIALLY_REFUNDED` or `SUCCEEDED` according to the refunds that still succeeded, and the amount is refundable again. The original entry is never changed.

### Checking a refund without a webhook

`POST /api/v1/payment-intents/{id}/refunds/{refundId}/refresh` (`MERCHANT_ADMIN`) reads the refund from Stripe and applies it with the same code as the webhook. It is safe to repeat; `change` says what happened (`REFUND_SUCCEEDED`, `REFUND_FAILED`, `REFUND_PENDING`, `REFUND_REVERSED`, or `null` when Stripe confirms the current status). A refund still `EXECUTING`, or one Stripe never identified, is `409 REFUND_NOT_REFRESHABLE`; Stripe unreachable is `503 PROCESSOR_LOOKUP_UNAVAILABLE`.

### Local delivery with ngrok

Stripe cannot reach `localhost`, so local work exposes the API through ngrok, with a traffic policy ([`ngrok/traffic-policy.yml`](ngrok/traffic-policy.yml)) that denies every request except `POST` to `/api/v1/webhooks/stripe/`: sign-in, merchants, payments, the health probes, and the documentation never become public.

1. Create a free account at <https://ngrok.com>. In the ngrok dashboard, copy your authtoken (**Getting Started**, **Your Authtoken**) and your free dev domain (**Domains**, for example `example-name.ngrok-free.app`). The dev domain does not change, so endpoints registered in Stripe stay valid across restarts.
2. In the repository-root `.env`, set `NGROK_AUTHTOKEN` and `NGROK_DOMAIN` (the domain without `https://`). Compose then passes `PUBLIC_API_BASE_URL=https://<NGROK_DOMAIN>` to the `dev` service.
3. Recreate `dev` and start the tunnel, then start the API (this stops anything running inside `dev`):

   ```bash
   docker compose --profile webhooks up -d
   ```

   ```bash
   docker compose exec dev pnpm dev
   ```

4. The ngrok inspection UI is at <http://127.0.0.1:4040> (published on the loopback only). `docker compose --profile webhooks stop ngrok` stops the tunnel.
5. Sign in to the web frontend as a merchant user, open **My merchant**, and in **Webhooks** click **Configure webhook** for each Stripe account (sandbox A on one merchant, sandbox B on another). In each Stripe sandbox, the endpoint and its deliveries are under **Developers**, **Webhooks** (Workbench), with the URL shown in the panel.

The `ngrok` service uses the official `ngrok/ngrok` image at an exact version, under the Compose profile `webhooks`, so `docker compose up -d` alone does not start it.

## Ledger

Each merchant has a double-entry payments ledger. It records the merchant's side of its own Stripe account: the funds go from Stripe to the merchant, and MerchantFlow never holds them or owes them.

**Accounts**, one per merchant and currency, created by the first posting that needs them:

| Code   | Name                 | Classification | Normal side | Meaning                                                              |
| ------ | -------------------- | -------------- | ----------- | -------------------------------------------------------------------- |
| `1100` | Processor receivable | `ASSET`        | `DEBIT`     | What the merchant's processor account owes it for captured sales     |
| `4000` | Sales                | `REVENUE`      | `CREDIT`    | Gross amount of the merchant's captured card sales                   |
| `4100` | Refunds              | `CONTRA_REVENUE` | `DEBIT`   | Captured sales returned to customers; it reduces Sales               |

**Posting.** A payment that reaches `SUCCEEDED`, through confirm, through 3D Secure completion, or, for a `MANUAL` payment, through its capture, posts one entry in the same database transaction: debit `1100`, credit `4000`, by the payment's amount, gross of processor fees. Its source is `PAYMENT_SALE` with the successful attempt's ID, which is unique, so the same success can never post twice. An authorization (`REQUIRES_CAPTURE`), a void, a decline, a failure, `REQUIRES_ACTION`, and `UNKNOWN` post nothing, and a failed posting rolls the payment's state change back too. Each `PAYMENT_INTENT_CONFIRMED` or `PAYMENT_INTENT_ACTION_COMPLETED` audit event names its `journal_entry_id` (`null` when nothing was posted).

**Refund posting.** A refund that Stripe reports as succeeded posts one entry in the transaction that records it: debit `4100` Refunds, credit `1100` Processor receivable, by the refunded amount. Its source is `PAYMENT_REFUND` with the refund's ID, so a refund can never post twice; a pending, failed, or unknown refund posts nothing.

**Refund reversal.** A refund that Stripe fails after it had succeeded posts the reverse entry: debit `1100`, credit `4100`, source `PAYMENT_REFUND_REVERSAL` with the refund's ID, once (see Stripe webhooks). A pending refund that succeeds later posts its refund entry when the webhook or a refund check applies it.

**Not recorded yet:** processor fees (Stripe reports them later), Stripe settlements and payouts to the merchant's bank, and disputes.

**Payments that succeeded before the ledger existed** have no entry until you run:

```bash
docker compose exec dev pnpm db:backfill-ledger
```

It posts the sale entry of every successful attempt that has none, by the same rule, one short transaction per sale with a `LEDGER_SALE_BACKFILLED` audit event (actor `SYSTEM` / `ledger-backfill`), and prints each posted entry and a summary. A backfilled entry's `posted_at` is the time of the run, not the time of the payment. A second run posts nothing (`Sale entries posted now: 0`); two runs at once are refused by a database lock; after a failure, running it again posts only what is still missing. It refuses to run with `NODE_ENV=production`.

**Guarantees in PostgreSQL:** every entry has at least two lines and exactly the lines it declares, and its debits equal its credits in every currency, checked by a deferred constraint trigger at commit; amounts are positive `BIGINT` minor units; a line has the currency of its account; entries, lines, and accounts reject `UPDATE`, `DELETE`, and `TRUNCATE`; a source is posted once.

**Endpoints** (`PLATFORM_ADMIN` for any merchant; `MERCHANT_ADMIN` and `MERCHANT_READ_ONLY` for their own; another merchant is `404 NOT_FOUND`):

- `GET /api/v1/merchants/{id}/ledger/balances`: `{"merchant_id", "data": [...]}`, each account with `account_id`, `code`, `name`, `classification`, `normal_side`, `currency`, `debit_total_minor`, `credit_total_minor`, `balance_minor` (normal-side total minus the other one; negative values start with `-`), and `created_at`. Balances are computed from the lines on each read; none is stored.
- `GET /api/v1/merchants/{id}/ledger/journal-entries?limit=&cursor=&payment_intent_id=`: `{"merchant_id", "data": [...], "next_cursor"}`, newest first by posting time, each entry with `id`, `source_type`, `source_id`, `payment_intent_id`, `description`, `posted_at`, and its `lines` (`line_number`, `ledger_account_id`, `account_code`, `account_name`, `side`, `amount_minor`, `currency`). Other query parameters are ignored.
- `GET /api/v1/merchants/{id}/ledger/journal-entries/{journalEntryId}`: one entry with its lines.

All amounts are integer strings of minor units.

## Audit log and payment timeline

**Audit log.** `GET /api/v1/audit-events?limit=&cursor=&action=&from=&to=` (all three roles) returns `{"data": [...], "next_cursor"}`, newest first by occurrence time and then id, with the pagination rules of the other lists (`limit` 1 to 100, default 20; pass `next_cursor` back unchanged as `cursor`; the cursor does not carry the filters). The scope comes only from the session or key: `PLATFORM_ADMIN` sees every event, including those that concern no merchant (platform keys, platform sign-ins); `MERCHANT_ADMIN` and `MERCHANT_READ_ONLY` see only the events of their own merchant, never one with no merchant. Filters:

- `action`: one recorded action, such as `PAYMENT_REFUND_APPLIED`; an unknown action is `400 VALIDATION_FAILED`;
- `from` (inclusive) and `to` (exclusive): ISO 8601 instants with `Z` or an offset, such as `2026-11-04T05:00:00Z` or `2026-11-04T00:00:00-05:00`; `to` must be after `from`.

Any other parameter, `merchant_id` included, a malformed cursor, or an invalid date is `400 VALIDATION_FAILED` with an issue per field. Each event has `id`, `occurred_at`, `action`, `target_type`, `target_id`, `merchant_id`, `correlation_id`, a readable `actor`, a short `summary`, and `metadata`.

**Actors.** A user appears with its display name and email (`USER`), an API key with its ID and role (`API_KEY`), and a system component with its name (`SYSTEM`, for example `processor-webhook` for a step resolved by a Stripe webhook, or `ledger-backfill`). For a merchant user, an action of the platform administrator (its user or a platform key) appears as `PLATFORM_ADMINISTRATOR`, "Platform administrator", with no email or ID. A user or key that no longer exists appears as `UNKNOWN`.

**What metadata shows.** Only reviewed fields are returned: identifiers of MerchantFlow rows, Stripe object IDs that the other endpoints already return (`pi_`, `re_`, `we_`, `acct_`), statuses, decline and failure codes, amounts as integer strings with their currency, and the merchant profile fields of `MERCHANT_UPDATED`. A key's `lookup_id` (part of the key a caller presents) is never returned, and a field that a later version records is hidden until it is reviewed. No secret, password hash, session or API key token, signing secret, provider payload, or card data is stored in the audit trail.

**Payment timeline.** `GET /api/v1/payment-intents/{id}/timeline` (`MERCHANT_ADMIN` and `MERCHANT_READ_ONLY` of the intent's merchant; another merchant's intent is `404`, the platform administrator `403`) returns `{"payment_intent_id", "merchant_id", "data": [...]}`, oldest first. It combines the order's creation, its attempts, its capture or void, its refunds, its journal entries, and the audit events about it, which record each step with its actor: the confirmation (3D Secure required, authorized, succeeded, declined), the 3D Secure completion, a resolution by a Stripe webhook, the capture or void, each refund and its resolution, and a refund reversed after it failed. Each item has `kind` (`PAYMENT_INTENT_CREATED`, `PAYMENT_ATTEMPT_STARTED`, `CAPTURE_REQUESTED`, `VOID_REQUESTED`, `REFUND_REQUESTED`, `AUDIT_EVENT`, `JOURNAL_ENTRY_POSTED`), `source_id`, `occurred_at` (a stored time), `summary`, `status`, `amount_minor` and `currency` where an amount applies, `actor` (audit events only), and `audit_action`. Record items show the record's current status. Items of the same instant are ordered by kind in the order listed above, then by `source_id`.

Both routes are in the OpenAPI document (tags Audit and Payment intents) and write nothing.

## Demonstration: two merchants, neither sees the other

This walk-through reproduces the first increment from a running stack: a platform administrator registers two merchants, activates them, and issues each an administrator key; each merchant then reads its own data and gets `404` for the other's. It uses synthetic data only. Docker Compose commands run on the host and `pnpm` commands inside the `dev` container (see Running commands); the `curl` commands run on the host. Replace each `<placeholder>` with the value the previous step printed. No real key appears in this document.

**1. Start the stack and install the dependencies** (Quick start, steps 1 and 2). Do not start `pnpm dev` yet: `pnpm db:migrate` and `pnpm db:seed` rebuild and empty `apps/api/dist`, which a running `pnpm dev` also writes to. If it is running, stop it first.

**2. Apply the migrations.**

```bash
docker compose exec dev pnpm db:migrate
```

**3. Create the platform administrator key.**

```bash
docker compose exec dev pnpm db:seed
```

The command prints the full key once, on its own line after `Platform administrator API key created`. Copy it now: only its hash is stored, so it cannot be shown again. The key is never written to a file or to the logs (the JSON log lines go to standard error). Save it in your shell for the next steps:

```bash
export PLATFORM_KEY='<key printed by db:seed>'
```

The seed refuses to run when `NODE_ENV` is `production`. It fails with a message, and creates nothing, when `DATABASE_URL` is invalid, PostgreSQL is unreachable, or the database is not migrated. Running it again is safe: while an active platform key exists it prints that one exists, with its row ID and creation time, changes nothing, and never prints a key. To get a key after losing the printed one, see Recover a lost platform key below.

**4. Start the API** and leave it running. Use a second terminal for the rest.

```bash
docker compose exec dev pnpm dev
```

**5. Register and activate two merchants.** Each `POST` answers `201` with the merchant, and its `id` goes into the next commands. A new merchant is `DRAFT` until the platform administrator activates it.

```bash
curl -sS -w '\nHTTP %{http_code}\n' -X POST http://127.0.0.1:3000/api/v1/merchants \
  -H "Authorization: Bearer $PLATFORM_KEY" -H 'Content-Type: application/json' \
  -d '{"legal_name":"Alpha Coffee LLC","display_name":"Alpha Coffee","business_type":"LLC","industry":"Retail","country_code":"US","default_currency":"USD"}'

curl -sS -w '\nHTTP %{http_code}\n' -X POST http://127.0.0.1:3000/api/v1/merchants \
  -H "Authorization: Bearer $PLATFORM_KEY" -H 'Content-Type: application/json' \
  -d '{"legal_name":"Beta Books LLC","display_name":"Beta Books","business_type":"LLC","industry":"Retail","country_code":"US","default_currency":"USD"}'
```

```bash
export MERCHANT_A_ID='<id of Alpha Coffee>'
export MERCHANT_B_ID='<id of Beta Books>'

curl -sS -w '\nHTTP %{http_code}\n' -X POST "http://127.0.0.1:3000/api/v1/merchants/$MERCHANT_A_ID/status" \
  -H "Authorization: Bearer $PLATFORM_KEY" -H 'Content-Type: application/json' -d '{"status":"ACTIVE"}'

curl -sS -w '\nHTTP %{http_code}\n' -X POST "http://127.0.0.1:3000/api/v1/merchants/$MERCHANT_B_ID/status" \
  -H "Authorization: Bearer $PLATFORM_KEY" -H 'Content-Type: application/json' -d '{"status":"ACTIVE"}'
```

Both answer `200` with `"status":"ACTIVE"`.

**6. Issue a `MERCHANT_ADMIN` key for each merchant.** Each answer is `201` and holds the key in its `key` field, once.

```bash
curl -sS -w '\nHTTP %{http_code}\n' -X POST "http://127.0.0.1:3000/api/v1/merchants/$MERCHANT_A_ID/api-keys" \
  -H "Authorization: Bearer $PLATFORM_KEY" -H 'Content-Type: application/json' -d '{"role":"MERCHANT_ADMIN"}'

curl -sS -w '\nHTTP %{http_code}\n' -X POST "http://127.0.0.1:3000/api/v1/merchants/$MERCHANT_B_ID/api-keys" \
  -H "Authorization: Bearer $PLATFORM_KEY" -H 'Content-Type: application/json' -d '{"role":"MERCHANT_ADMIN"}'
```

```bash
export KEY_A='<key of Alpha Coffee>'
export KEY_B='<key of Beta Books>'
```

**7. Each merchant reads its own data, and gets `404` for the other's.** The first and fourth commands answer `200` with the caller's own merchant. The second and third answer `404 NOT_FOUND`, with the same body as for a merchant that does not exist.

```bash
curl -sS -w '\nHTTP %{http_code}\n' "http://127.0.0.1:3000/api/v1/merchants/$MERCHANT_A_ID" -H "Authorization: Bearer $KEY_A"
curl -sS -w '\nHTTP %{http_code}\n' "http://127.0.0.1:3000/api/v1/merchants/$MERCHANT_B_ID" -H "Authorization: Bearer $KEY_A"
curl -sS -w '\nHTTP %{http_code}\n' "http://127.0.0.1:3000/api/v1/merchants/$MERCHANT_A_ID" -H "Authorization: Bearer $KEY_B"
curl -sS -w '\nHTTP %{http_code}\n' "http://127.0.0.1:3000/api/v1/merchants/$MERCHANT_B_ID" -H "Authorization: Bearer $KEY_B"
```

A merchant key also lists only its own merchant, and cannot change a status (`403 INSUFFICIENT_ROLE`). A `MERCHANT_ADMIN` key may issue and revoke keys, but only of its own merchant and only with a merchant role:

```bash
curl -sS -w '\nHTTP %{http_code}\n' "http://127.0.0.1:3000/api/v1/merchants" -H "Authorization: Bearer $KEY_A"
curl -sS -w '\nHTTP %{http_code}\n' -X POST "http://127.0.0.1:3000/api/v1/merchants/$MERCHANT_A_ID/status" \
  -H "Authorization: Bearer $KEY_A" -H 'Content-Type: application/json' -d '{"status":"SUSPENDED"}'
```

**8. Clean up.** The demonstration leaves two merchants, three keys, and their audit events in the Compose database. Stop the API, unset the variables (`unset PLATFORM_KEY KEY_A KEY_B MERCHANT_A_ID MERCHANT_B_ID`), and delete the data with `docker compose down --volumes`, which also deletes the dependency volumes. Rows of `api_keys` and `audit_events` cannot be deleted one by one, by design.

### Recover a lost platform key

A key that was not saved cannot be shown again, and the seed will not create a second one while the first is active. In development, revoke it and run the seed again. The statement below is a manual change: it writes no audit event.

```bash
docker compose exec postgres psql -U merchantflow -d merchantflow \
  -c "UPDATE api_keys SET revoked_at = now() WHERE merchant_id IS NULL AND revoked_at IS NULL"
docker compose exec dev pnpm db:seed
```

Alternatively, `docker compose down --volumes` followed by the Quick start gives an empty database.

## Web frontend

`apps/web` is a React and TypeScript single-page app, built with Vite, routed with React Router, and styled with plain Bootstrap 5 CSS. It calls the API from the browser through one client module (`apps/web/src/api/client.ts`) that sends the session token as `Authorization: Bearer <token>`. It has:

- sign-in and sign-out, and an Account page with the signed-in user and role from `GET /auth/me`;
- for the platform administrator: the merchants list (`/merchants`, with **Load more** for the next page), the create form (`/merchants/new`), the activate, suspend, and reactivate buttons the current status allows, and each merchant's page (`/merchants/{id}`);
- on a merchant's page: its users (create, list, disable with a confirmation), its API keys (issue with a merchant role, list, revoke with a confirmation), and its processor accounts (connect a Stripe test account with both keys, list with the secret key's last four characters, make one the default, disable with a confirmation), with a **Webhooks** panel per account: the endpoint URL with a copy button, **Configure webhook** (then replace or remove, each confirmed), a password field for a signing secret pasted from the Stripe Dashboard (cleared as soon as it is submitted), the secret's last four characters, the mode and time of the configuration, and the latest events received with their type, time, and outcome. A new user's password and a new key are shown once, with a copy button, and are forgotten when their dialog closes; the Stripe secret key field is a password field, cleared as soon as the form is submitted;
- for a merchant user: only its own merchant's page, where it lands after sign-in, with no merchant list and no status buttons. Any other merchant's page shows the API's `404`;
- for a merchant user, a **Payments** section (the platform administrator does not have it, because the payment endpoints refuse platform roles):
  - the list (`/payments`): reference, amount, currency, status, and creation time, newest first, a status filter kept in the URL (`/payments?status=CREATED`), **Load more** for the next page, and a click on a row to open the order;
  - the create form (`/payments/new`, `MERCHANT_ADMIN` only): the amount is typed in major units, such as `100.50`, and sent as `amount_minor` (`"10050"`); the currency is the merchant's default currency and cannot be changed; the order reference is the merchant's own identifier; **Capture** chooses Automatic (the default) or Manual (authorize only, then capture or void on the order's page). An amount that is empty, negative, malformed, or has more decimals than the currency allows (`100.505` for USD) is refused before anything is sent. Errors show their code, correlation ID, and for `VALIDATION_FAILED` the invalid fields. A successful creation opens the order's page;
  - the order's page (`/payments/{id}`), with every field, the formatted amount, the status as a badge, and the attempt history (account, status, Stripe `pi_` ID, decline code, error category, times). Another merchant's order, or an unknown id, shows the API's `404`;
  - on a `CREATED` order, for `MERCHANT_ADMIN`, **Pay with a card**: Stripe's card field (Stripe Elements) loaded with the publishable key of the merchant's enabled default account, a list of Stripe test cards, and **Pay**. Stripe.js turns the card into a payment method in the browser and only its `pm_` ID reaches the API. 3D Secure opens Stripe's challenge in the page and the result is applied right after. The page then shows the outcome: success, a decline with its code and "try another card", or an unknown outcome with a warning not to pay again. Without an enabled default account the section links to the merchant's processor accounts;
  - on a `REQUIRES_ACTION` order, **Continue authentication** opens the 3D Secure challenge again, for example after a reload;
  - on a `MANUAL` order, **Capture**: on a `REQUIRES_CAPTURE` order the held amount, and for `MERCHANT_ADMIN` **Capture** and **Void**, each confirmed in a dialog, with the outcome and errors with their code and correlation ID. One `Idempotency-Key` per action: after a network error, `OPERATION_IN_PROGRESS`, a `503`, or a server error, **Send the same capture again** (or void) reuses it. Below, the history of captures and voids, where an `UNKNOWN` one has **Check with Stripe** for `MERCHANT_ADMIN`. Every action reloads the status, attempts, refunds, and journal entries;
  - on a `SUCCEEDED` or `PARTIALLY_REFUNDED` order, for `MERCHANT_ADMIN`, **Refund**: the amount is typed in major units and defaults to the remaining refundable amount (a full refund; **Full remaining** restores it), and a smaller amount is a partial refund. One `Idempotency-Key` per refund: after a network error, `OPERATION_IN_PROGRESS`, a `503`, or a server error, **Send the same refund again** reuses it; any other answer or a different amount starts a new one. The outcome (succeeded, pending, failed, unknown) and errors with their code and correlation ID are shown;
  - on every order's page, its **Refunds**: the captured, refunded, pending, and remaining amounts, and a table with each refund's amount, status, Stripe `re_` ID, account, failure, and times; for `MERCHANT_ADMIN`, each `PENDING` or `UNKNOWN` refund has **Check with Stripe**, which applies what Stripe reports and reloads the page;
  - on every order's page, its **Journal entries** with their debit and credit lines, and its **Timeline**: every step oldest first, with time, step, what happened, amount, and who did it (the records of the order, its attempts, captures, voids, refunds, and journal entries are shaded and show their current status);
- an **Audit log** page (`/audit`, in the navigation bar of the platform administrator and of merchant users): time, action, who, summary, target, correlation ID, and for the platform administrator the merchant, newest first with **Load more**. The filters (an action and a range of days, both days included) are kept in the URL (`/audit?action=PAYMENT_REFUND_APPLIED&from=2026-11-04&to=2026-11-04`); days are those of the browser's time zone and are sent as UTC instants (the start of the first day and the start of the day after the last). Errors show their code, correlation ID, and invalid fields;
- a **Ledger** page per merchant (`/merchants/{id}/ledger`): for a merchant user under **Ledger** in the navigation bar, for the platform administrator through the **Ledger** button of each merchant's page. It shows the accounts with code, name, classification, normal side, currency, debit and credit totals, and balance, and the journal entries newest first with **Load more**.

1. With the stack running and the dependencies installed (Quick start steps 1 and 2), apply the migrations and run the seed. The seed prints the administrator's email and a generated password **once**; store the password.

   ```bash
   docker compose exec dev pnpm db:migrate
   docker compose exec dev pnpm db:seed
   ```

2. Start the API (Quick start step 3) and, in another terminal, the frontend:

   ```bash
   docker compose exec dev pnpm dev:web
   ```

3. Open <http://localhost:5173> and sign in with the seeded email (`admin@merchantflow.test` unless `SEED_ADMIN_EMAIL` says otherwise) and the printed password. The merchants list opens. **Sign out** returns to the sign-in screen and revokes the session.
4. Create a merchant, activate it, open its page, and create a user. Copy the password from the dialog, sign out, and sign in as that user: its merchant's page opens, where it can issue and revoke keys and create and disable other users of the same merchant.

Notes:

- The pay section uses one `Idempotency-Key` per payment method. After a network error, `409 OPERATION_IN_PROGRESS`, or a `5xx`, **Send the same payment again** reuses the same payment method and key, so it cannot charge twice; entering a card again creates a new payment method and a new key.
- Stripe test cards (any future expiry date, any CVC, any postal code): `4242 4242 4242 4242` succeeds; `4000 0000 0000 9995` is declined (insufficient funds); `4000 0000 0000 3220` asks for 3D Secure and then succeeds; `4000 0084 0000 1629` asks for 3D Secure and is then declined. In the test challenge, **Complete** authenticates and **Fail** refuses.
- Stripe.js is loaded from `js.stripe.com` only when a pay section opens.
- The create form generates one `Idempotency-Key` per order. Sending the same values again after any failure, such as a network error or a `503`, reuses it, so an order whose answer was lost is not created twice. Different values, or a successful creation, start a new key. Values are compared as sent, so `100.5` and `100.50` are the same order.
- Amounts are converted and displayed with text operations only and never pass through a JavaScript `number`.
- Any API error is shown with its `code` and correlation ID. A `401` on any call after sign-in clears the token and returns to the sign-in screen.
- The token is kept in the tab's `sessionStorage`: it survives a reload, and closing the tab forgets it.
- The browser calls the API at `VITE_API_BASE_URL` (default `http://localhost:3000/api/v1`), read by Vite from the repository-root `.env`.
- The API answers browsers only from the origins in `CORS_ALLOWED_ORIGINS` (see Configuration). By default, outside production, those are `http://localhost:5173` and `http://127.0.0.1:5173`. To serve the frontend from another origin, list it there, for example `CORS_ALLOWED_ORIGINS=http://localhost:5173,https://demo.example.test`, and restart the API. Wildcards are not accepted.

### Recover a lost administrator password

A password that was not saved cannot be shown again, and the seed does not create a second platform user while one exists. In development, delete the user and its sessions and run the seed again. These statements are manual changes and write no audit event.

```bash
docker compose exec postgres psql -U merchantflow -d merchantflow \
  -c "DELETE FROM user_sessions WHERE user_id IN (SELECT id FROM users WHERE merchant_id IS NULL)" \
  -c "DELETE FROM users WHERE merchant_id IS NULL"
docker compose exec dev pnpm db:seed
```

## Authentication

Every route requires an API key or a user session token unless it is explicitly marked public. Send it as `Authorization: Bearer mfk_<lookup id>_<secret>` (API key) or `Authorization: Bearer mfs_<lookup id>_<secret>` (session token). The health probes, `POST /api/v1/auth/login`, and the OpenAPI document (outside production) need neither.

- A missing header, another scheme, a malformed token, an unknown key or session, a wrong secret, a revoked key, a signed-out or expired session, and a session of a disabled user all receive the same `401` with code `UNAUTHENTICATED` and a `WWW-Authenticate: Bearer` header, so a caller cannot tell which case occurred.
- A valid key whose role a route does not accept receives `403` with code `INSUFFICIENT_ROLE`.
- Revocation is checked on every request and nothing is cached, so a revoked key stops working with its next request.
- A route that declares neither the roles it accepts nor that it is public is denied, even to a valid key.
- The merchant a request acts for comes only from the key, never from the path, query, body, or a header.
- A key of a `DRAFT` or `SUSPENDED` merchant still authenticates; what each status allows is decided by the command that runs, not by the guard.
- Logs record the key's or the user's row ID, the role, and the merchant ID, and never a key, a token, a password, or any part of a secret.

Users sign in with an email and a password:

- `POST /api/v1/auth/login` with `{"email": "...", "password": "..."}` returns `{ token, expires_at, principal }`. The email is compared in lower case. An unknown email, a wrong password, and a disabled user all receive the same `401 INVALID_CREDENTIALS`, and each attempt costs the same scrypt comparison. The token is shown only in this response.
- A session lasts 8 hours from sign-in and is never extended. Passwords are stored only as salted scrypt hashes; tokens only as SHA-256 hashes.
- `POST /api/v1/auth/logout` revokes the session of the request (`204`); the token gets `401` afterwards. An API key gets `403 SESSION_REQUIRED` and stays valid. Every role may call it and `GET /api/v1/auth/me`.
- `GET /api/v1/auth/me` returns the caller: a user with its ID, display name, email, role, and merchant, or an API key with its ID, role, and merchant.
- A signed-in user acts with the same role and merchant rules as an API key, and its actions record `actor_type` `USER` and the user's ID in the audit trail. Sign-in and sign-out are audited as `USER_SESSION_CREATED` and `USER_SESSION_REVOKED`.

```bash
curl -sS -X POST http://127.0.0.1:3000/api/v1/auth/login \
  -H 'Content-Type: application/json' -d '{"email":"admin@merchantflow.test","password":"<printed password>"}'
curl -sS http://127.0.0.1:3000/api/v1/auth/me -H "Authorization: Bearer $TOKEN"
curl -sS -i -X POST http://127.0.0.1:3000/api/v1/auth/logout -H "Authorization: Bearer $TOKEN"
```

## Configuration

The API reads its configuration from environment variables and refuses to start, with an error that names the invalid variable but never its value, when one is invalid.

| Variable       | Default       | Description                                                                        |
| -------------- | ------------- | ---------------------------------------------------------------------------------- |
| `NODE_ENV`     | `development` | Runtime mode: `development`, `test`, or `production`                               |
| `HOST`         | `127.0.0.1`   | Interface the API binds to; Compose sets `0.0.0.0` inside the `dev` container      |
| `PORT`         | `3000`        | TCP port the API listens on inside the container                                   |
| `LOG_LEVEL`    | `info`        | Minimum log level: `fatal`, `error`, `warn`, `info`, `debug`, `trace`, or `silent` |
| `DATABASE_URL` | none          | PostgreSQL connection URI; required, and never logged                              |
| `CORS_ALLOWED_ORIGINS` | `http://localhost:5173,http://127.0.0.1:5173` outside production; none in production | Comma-separated browser origins (`scheme://host[:port]`, no path, no wildcard) allowed to call the API |
| `SEED_ADMIN_EMAIL` | `admin@merchantflow.test` | Email of the platform administrator user created by `pnpm db:seed` |
| `VITE_API_BASE_URL` | `http://localhost:3000/api/v1` | API base URL the web frontend calls; read by Vite, not by the API |
| `CREDENTIALS_MASTER_KEY` | none | 32 random bytes in standard base64 that encrypt processor secret keys; a secret. Unset: development and test start, and connecting an account answers `503`; production does not start. An invalid value stops startup |
| `PUBLIC_API_BASE_URL` | none | Public base URL of the API (`scheme://host[:port]`, no path) where Stripe delivers webhooks. Compose sets `https://<NGROK_DOMAIN>` for `dev` when `NGROK_DOMAIN` is set. Unset: the automatic webhook configuration answers `503 PUBLIC_BASE_URL_NOT_CONFIGURED` |
| `NGROK_AUTHTOKEN`, `NGROK_DOMAIN` | none | Authtoken (a secret) and free dev domain (without `https://`) of your ngrok account, for the `webhooks` Compose profile; the API never reads them |
| `STRIPE_TEST_A_SECRET_KEY`, `STRIPE_TEST_A_PUBLISHABLE_KEY`, `STRIPE_TEST_B_SECRET_KEY`, `STRIPE_TEST_B_PUBLISHABLE_KEY` | none | Test keys of two of your Stripe sandboxes, A and B, for manual checks only (two sandboxes let you move the default between real accounts); the API never reads them |

[`.env.example`](.env.example) is the reference for every variable. Docker Compose already sets `HOST` and `DATABASE_URL` for the `dev` container, so the quick start needs no `.env` file.

Compose also passes `CREDENTIALS_MASTER_KEY` and the four `STRIPE_TEST_A_*` and `STRIPE_TEST_B_*` keys into the `dev` container from your shell or from the repository-root `.env`, which Compose reads for interpolation. After setting or changing them, recreate the container with `docker compose up -d` (this stops anything running inside it, such as `pnpm dev`), and start the API again. To create a master key:

```bash
docker compose exec -T dev node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Keep it: losing it makes every stored secret key unreadable, and the accounts must be connected again. To override a value, copy `.env.example` to `.env` in the repository root; `.env` is ignored by Git and must never be committed. The local database password defaults to a throwaway development value and can be changed with the `POSTGRES_PASSWORD` environment variable when running `docker compose`.

## Current limitations

- A request the JSON body parser rejects (malformed JSON, for instance) receives the standard error but writes no access log line.
- No rate limit or input size limit beyond the parser's default exists yet, sign-in included. There is no password reset, email verification, or multi-factor authentication.
- Every merchant user is `MERCHANT_ADMIN`; there is no role choice, re-enabling, password change, or deletion of users yet, and the lists of a merchant's users and keys are not paginated. Platform users are created only by the seed. Only the payment intent commands (creation, confirmation, refunds, capture, and void) take an idempotency key: creating a merchant twice creates two merchants.
- **A payment whose outcome is unknown stays blocked.** Automatic recovery does not exist yet: a crash of the API while it waits for Stripe, a failure to record Stripe's answer, or an `UNKNOWN` result (a timeout, a connection error, a Stripe server error) leaves the attempt `EXECUTING` or `UNKNOWN` and the intent `PROCESSING` or `UNKNOWN`, and no new attempt is accepted for it until recovery exists. Check such a payment in the Stripe Dashboard by its metadata. A payment left in `REQUIRES_ACTION` also blocks new attempts until the customer completes or fails the challenge.
- Payments use Stripe in test mode and cards only. Manual capture captures the whole amount only (no partial capture), and nothing tracks when an authorization expires: a hold Stripe released after seven days, or a capture or void made in the Stripe Dashboard, leaves the order `REQUIRES_CAPTURE` in MerchantFlow (its webhook event is recorded and changes nothing), and a later capture is refused by Stripe and recorded as `FAILED`. A capture or void whose outcome is unknown blocks new ones until its webhook or **Check with Stripe** resolves it. A refund that Stripe leaves `pending` stays `PENDING` with its amount reserved until a webhook or **Check with Stripe** resolves it. A refund or payment whose outcome is unknown and that never learned its Stripe ID can only be resolved by a webhook that names it; nothing looks it up on its own. Webhooks are processed synchronously in the request (no outbox or worker), and an event Stripe stops redelivering after its retries is not fetched again: use the refund check. The ledger records captured sales and successful refunds: no processor fee, settlement, or payout, and a payment that succeeded before the ledger existed has no entry until `pnpm db:backfill-ledger` runs. Its tables reject changes through triggers that a database superuser or the table owner can still disable. Stripe's PaymentIntent amount limit (99,999,999 minor units) is refused before any call, as a `FAILED` attempt.
- Idempotency records are kept and never deleted (no purge exists). `payment_intents`, `payment_attempts`, `refunds`, and `processor_events` reject deletes, and changes of an intent's amount, currency, reference, or merchant, of a finished attempt, of a failed refund, of a succeeded refund except to fail, or of a processed event, through triggers that a database superuser or the table owner can still disable.
- The other business endpoints are the merchant endpoints: no platform key can be issued through the API; the development seed is the only way to create one, and a lost platform key is replaced by revoking it in the database (see Recover a lost platform key). The simulated processor and dashboard are planned.
- The error responses of the health endpoints and of the unknown-route handler are not described in the OpenAPI document.
- A merchant or payment intent created by a transaction that commits late can be missed by a list walk already past its position; the next walk shows it.
- The status filter of the payment intent list reads the merchant's intents newest first and keeps those in the status, so a rare status among many intents takes longer to fill a page.
- `api_keys` accepts only the `PLATFORM_ADMIN`, `MERCHANT_ADMIN`, and `MERCHANT_READ_ONLY` roles; rows can be revoked once and never removed or reactivated, through triggers that a database superuser or the table owner can still disable.
- `audit_events` rejects updates, deletes, and truncation through a trigger, which a database superuser or the table owner can still disable. Audit metadata must never hold secrets or payment credentials.
- The audit log's `action` filter is checked on the events the time-ordered scan reaches, so a rare action among very many events takes longer to fill a page. The list of filterable actions is kept by hand in the API and in the frontend; an action added later is listed but cannot be filtered until it is added. The timeline is not paginated and reads its sources in separate queries outside a transaction, so a step that commits during the read may show in part until the next read. Actions done directly in the Stripe Dashboard and webhook events that changed nothing appear only in the webhook panel, not in the timeline.
- The API's database pool has 10 connections. A request that waits more than 2 seconds for one, on any endpoint, receives `503 SERVICE_BUSY` with `Retry-After` and changed nothing; `GET /health/ready` answers `503` while the pool stays full.
- Processor accounts: the publishable key is not checked against the secret key's account; the master key cannot be rotated yet (the stored key version allows it later); the list is not paginated; a disabled account cannot be re-enabled.
- The setup is verified on Docker Desktop only (see Prerequisites).
- The GitHub Actions workflow has not run on a hosted runner yet.
- There is no production build, deployment configuration, or container image for running the API outside development.
