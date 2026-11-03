# MerchantFlow

MerchantFlow is a payment orchestration reference platform built as a modular monolith with NestJS and PostgreSQL.

> **MerchantFlow is a reference implementation.** It uses synthetic data, processes no real money, and is **not production ready or certified** for any payment standard. Never point it at real payment credentials or real cardholder data.

## Overview

Today the repository contains the runnable foundation only:

- a pnpm workspace with a NestJS API (`apps/api`), a PostgreSQL access package (`packages/database`), and a web frontend (`apps/web`, React, Vite, and Bootstrap 5) with sign-in and sign-out (see Web frontend);
- liveness and readiness endpoints, `GET /health/live` and `GET /health/ready`;
- validated environment configuration that stops the API at startup when it is invalid;
- structured JSON logs with a correlation ID on every request;
- one error format for every failure, with a stable `code`, a safe message, and the correlation ID, plus request validation with Zod and an OpenAPI document served outside production (see API conventions);
- a forward-only SQL migration runner (`pnpm db:migrate`);
- database tables for merchants, API keys, users, user sessions, an append-only audit trail, idempotency records, and payment intents, with the constraints enforced by PostgreSQL itself;
- API keys: 256 bits of randomness, only a lookup identifier and a SHA-256 hash stored, and an audit event for each issuance and revocation;
- request authentication: a global guard checks the `Authorization: Bearer <token>` header, an API key or a user session token, against the stored hash on every request, with deny-by-default routing and role checks (see Authentication);
- user sign-in: `POST /api/v1/auth/login` with an email and a password (scrypt hashes only), `POST /api/v1/auth/logout`, and `GET /api/v1/auth/me`;
- merchant endpoints under `/api/v1/merchants`: create, read, list with stable pagination, update, change status, and issue and revoke API keys, each with role rules, tenant isolation, and an audit event (see Merchant endpoints);
- payment intent creation, `POST /api/v1/payment-intents`, with a required `Idempotency-Key` and protection against a second intent for the same merchant order (see Payment intents); nothing is charged;
- payment intent retrieval, `GET /api/v1/payment-intents/{id}`, scoped to the merchant of the key (see Payment intents);
- a development seed, `pnpm db:seed`, that creates the first platform administrator key and the platform administrator user (see Demonstration: two merchants, neither sees the other, and Web frontend);
- linting, formatting, type checking, unit tests, and integration tests against a real PostgreSQL started with Testcontainers, including an HTTP concurrency suite (`tests/concurrency`) that sends 50 simultaneous requests to the listening API and checks that duplicates create one intent;
- a GitHub Actions workflow that runs the same checks.

Merchant users and every frontend screen other than sign-in and the signed-in home page, listing payment intents, confirming (charging) one, processors, the ledger, and every other business capability are planned and do not exist yet.

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

All of them need an API key (see Authentication) and use `snake_case` fields. Merchants start in `DRAFT`; the allowed status changes are `DRAFT` to `ACTIVE`, `ACTIVE` to `SUSPENDED`, and `SUSPENDED` to `ACTIVE`.

| Endpoint                                                | `PLATFORM_ADMIN` | `MERCHANT_ADMIN`            | `MERCHANT_READ_ONLY` |
| ------------------------------------------------------- | ---------------- | --------------------------- | -------------------- |
| `POST /api/v1/merchants`                                | creates          | 403                         | 403                  |
| `GET /api/v1/merchants`                                 | lists all        | lists its own merchant      | lists its own        |
| `GET /api/v1/merchants/{id}`                            | any merchant     | its own merchant            | its own merchant     |
| `PATCH /api/v1/merchants/{id}`                          | five profile fields | `display_name`, `industry` of its own | 403         |
| `POST /api/v1/merchants/{id}/status`                    | changes status   | 403                         | 403                  |
| `POST /api/v1/merchants/{id}/api-keys`                  | issues a key     | 403                         | 403                  |
| `POST /api/v1/merchants/{id}/api-keys/{apiKeyId}/revoke` | revokes a key   | 403                         | 403                  |

- A merchant key that names any merchant other than its own gets `404 NOT_FOUND` before any role check, and the answer is the same as for a merchant that does not exist. For its own merchant, a forbidden operation, field, or status change is `403 INSUFFICIENT_ROLE` and nothing changes, also when the merchant is suspended. A merchant administrator may still edit `display_name` and `industry` while its merchant is suspended.
- A platform administrator updates `legal_name`, `display_name`, `business_type`, `industry`, and `country_code`. `default_currency` is fixed when the merchant is created, and the status changes only through `POST .../status`.
- `default_currency` accepts only a supported currency, which is `USD` for now (the OpenAPI document lists the accepted codes). Any other code, including a well-formed one such as `EUR`, is a `400 VALIDATION_FAILED` with an issue on `default_currency` and the rule code `invalid_value`, and nothing is stored.
- Request bodies and query strings are strict: an unknown field is a `400 VALIDATION_FAILED`.
- Creating a merchant does not issue a key. `POST .../api-keys` with `{"role": "MERCHANT_ADMIN"}` or `{"role": "MERCHANT_READ_ONLY"}` returns the key once, with `Cache-Control: no-store`; it is stored only as a hash and cannot be retrieved again. A revoked key stops working with its next request.
- `GET /api/v1/merchants?limit=20&cursor=...` returns `{"data": [...], "next_cursor": "..."}` ordered by creation time and then id. `limit` is 1 to 100 (default 20). Pass `next_cursor` back unchanged as `cursor`; it is `null` on the last page. An invalid cursor is a `400`. A walk over the pages never repeats a merchant, and never skips one that existed when it began.
- Every change writes one audit event in the same transaction, naming the API key that made it and the request's correlation ID. Updates record the previous and new values of the changed fields.
- The OpenAPI document (outside production) lists each endpoint with its roles, schemas, error responses, and the `bearer` security scheme.

The first platform administrator key cannot be created through the API; `pnpm db:seed` creates it (see Demonstration).

## Payment intents

A payment intent is a merchant's intention to collect an amount. Creating one charges nothing; confirming it through a processor is planned.

`POST /api/v1/payment-intents` needs a `MERCHANT_ADMIN` key of an `ACTIVE` merchant and an `Idempotency-Key` header. The intent always belongs to the merchant of the key.

```bash
curl -sS -w '\nHTTP %{http_code}\n' -X POST http://127.0.0.1:3000/api/v1/payment-intents \
  -H "Authorization: Bearer $KEY_A" -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: order-1001-attempt-1' \
  -d '{"amount_minor":"1000","currency":"USD","merchant_reference":"order-1001"}'
```

The answer is `201` with `id`, `merchant_id`, `amount_minor`, `currency`, `merchant_reference`, `status` (`CREATED`), `created_at`, and `updated_at`.

- `amount_minor` is the amount in minor units as an integer string greater than zero, for example `"1000"` for 10.00 USD, up to `"9223372036854775807"`. It is never read as a JSON number: a number, a sign, a decimal point, spaces, or leading zeros are a `400 VALIDATION_FAILED` whose issue names the reason (`invalid_type`, `empty`, `invalid_format`, `leading_zero`, `out_of_range`, or `not_positive`).
- `currency` must be a supported currency (`USD` for now) and the merchant's `default_currency`; a supported currency that differs is `422 MERCHANT_CURRENCY_MISMATCH`.
- `merchant_reference` is the merchant's own order identifier: 1 to 128 visible ASCII characters, case-sensitive. A merchant has at most one intent per reference, whatever key created it: a new key with a taken reference is `409 DUPLICATE_MERCHANT_REFERENCE`.
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

A merchant key also lists only its own merchant, and cannot change a status or issue keys (`403 INSUFFICIENT_ROLE`):

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

`apps/web` is a React and TypeScript single-page app, built with Vite and styled with plain Bootstrap 5 CSS. It calls the API from the browser through one client module (`apps/web/src/api/client.ts`) that sends the session token as `Authorization: Bearer <token>`. Today it has the sign-in screen, a home page that shows the signed-in user and role from `GET /auth/me`, and sign-out.

1. With the stack running and the dependencies installed (Quick start steps 1 and 2), apply the migrations and run the seed. The seed prints the administrator's email and a generated password **once**; store the password.

   ```bash
   docker compose exec dev pnpm db:migrate
   docker compose exec dev pnpm db:seed
   ```

2. Start the API (Quick start step 3) and, in another terminal, the frontend:

   ```bash
   docker compose exec dev pnpm dev:web
   ```

3. Open <http://localhost:5173> and sign in with the seeded email (`admin@merchantflow.test` unless `SEED_ADMIN_EMAIL` says otherwise) and the printed password. The home page shows the user, the role, and no merchant. **Sign out** returns to the sign-in screen and revokes the session.

Notes:

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
- `POST /api/v1/auth/logout` revokes the session of the request (`204`); the token gets `401` afterwards. An API key gets `403 SESSION_REQUIRED` and stays valid.
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

[`.env.example`](.env.example) is the reference for every variable. Docker Compose already sets `HOST` and `DATABASE_URL` for the `dev` container, so the quick start needs no `.env` file. To override a value, copy `.env.example` to `.env` in the repository root; `.env` is ignored by Git and must never be committed. The local database password defaults to a throwaway development value and can be changed with the `POSTGRES_PASSWORD` environment variable when running `docker compose`.

## Current limitations

- A request the JSON body parser rejects (malformed JSON, for instance) receives the standard error but writes no access log line.
- No rate limit or input size limit beyond the parser's default exists yet, sign-in included. There is no password reset, email verification, or multi-factor authentication.
- Only the platform administrator user exists: merchant users are planned. `GET /auth/me` and `POST /auth/logout` accept only the `PLATFORM_ADMIN` role for now. Only payment intent creation takes an idempotency key: creating a merchant twice creates two merchants.
- There is no endpoint to list payment intents yet, nor to confirm one; idempotency records are kept and never deleted (no purge exists). `payment_intents` rejects deletes and changes of an intent's amount, currency, reference, or merchant through triggers that a database superuser or the table owner can still disable.
- The other business endpoints are the merchant endpoints: there is no endpoint to list the keys of a merchant (a key can be revoked by the `id` returned when it was issued), and no platform key can be issued through the API; the development seed is the only way to create one, and a lost platform key is replaced by revoking it in the database (see Recover a lost platform key). Payment confirmation, processors, ledger, and dashboard are planned.
- The error responses of the health endpoints and of the unknown-route handler are not described in the OpenAPI document.
- A merchant created or changed by a transaction that commits late can be missed by a list walk already past its position; the next walk shows it.
- `api_keys` accepts only the `PLATFORM_ADMIN`, `MERCHANT_ADMIN`, and `MERCHANT_READ_ONLY` roles; rows can be revoked once and never removed or reactivated, through triggers that a database superuser or the table owner can still disable.
- `audit_events` rejects updates, deletes, and truncation through a trigger, which a database superuser or the table owner can still disable. Audit metadata must never hold secrets or payment credentials.
- The API's database pool has 10 connections. A request that waits more than 2 seconds for one, on any endpoint, receives `503 SERVICE_BUSY` with `Retry-After` and changed nothing; `GET /health/ready` answers `503` while the pool stays full.
- The setup is verified on Docker Desktop only (see Prerequisites).
- The GitHub Actions workflow has not run on a hosted runner yet.
- There is no production build, deployment configuration, or container image for running the API outside development.
