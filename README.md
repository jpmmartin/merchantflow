# MerchantFlow

MerchantFlow is a payment orchestration reference platform built as a modular monolith with NestJS and PostgreSQL.

> **MerchantFlow is a reference implementation.** It uses synthetic data, processes no real money, and is **not production ready or certified** for any payment standard. Never point it at real payment credentials or real cardholder data.

## Overview

Today the repository contains the runnable foundation only:

- a pnpm workspace with a NestJS API (`apps/api`) and a PostgreSQL access package (`packages/database`);
- liveness and readiness endpoints, `GET /health/live` and `GET /health/ready`;
- validated environment configuration that stops the API at startup when it is invalid;
- structured JSON logs with a correlation ID on every request;
- one error format for every failure, with a stable `code`, a safe message, and the correlation ID, plus request validation with Zod and an OpenAPI document served outside production (see API conventions);
- a forward-only SQL migration runner (`pnpm db:migrate`);
- database tables for merchants, API keys, and an append-only audit trail, with the constraints enforced by PostgreSQL itself;
- API keys: 256 bits of randomness, only a lookup identifier and a SHA-256 hash stored, and an audit event for each issuance and revocation;
- request authentication: a global guard checks the `Authorization: Bearer <key>` header against the stored hash on every request, with deny-by-default routing and role checks (see Authentication);
- merchant endpoints under `/api/v1/merchants`: create, read, list with stable pagination, update, change status, and issue and revoke API keys, each with role rules, tenant isolation, and an audit event (see Merchant endpoints);
- a development seed, `pnpm db:seed`, that creates the first platform administrator key (see Demonstration: two merchants, neither sees the other);
- linting, formatting, type checking, unit tests, and integration tests against a real PostgreSQL started with Testcontainers;
- a GitHub Actions workflow that runs the same checks.

Payments, processors, the ledger, and every other business capability are planned and do not exist yet.

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

The API is published on `127.0.0.1:3000` and PostgreSQL on `127.0.0.1:5434`, both only on the local machine. If either port is taken, stop the process that uses it before starting the stack.

## Running commands

Two kinds of commands are used:

- `docker compose ...` runs on the host and manages the containers.
- Project commands run inside the `dev` container with `docker compose exec dev <command>`, for example `docker compose exec dev pnpm test`.

## Available commands

Run each of these as `docker compose exec dev pnpm <script>`.

| Script             | What it does                                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------------- |
| `dev`              | Builds the database package and starts the API in watch mode on port 3000                               |
| `build`            | Compiles every package                                                                                  |
| `test`             | Runs the unit and API tests; they need no database                                                      |
| `test:integration` | Runs the integration tests; they start PostgreSQL containers through Testcontainers and need Docker     |
| `lint`             | Runs ESLint, including type-aware rules                                                                 |
| `typecheck`        | Type-checks every package without emitting files                                                        |
| `format`           | Rewrites files with Prettier                                                                            |
| `format:check`     | Fails if any file is not formatted with Prettier                                                        |
| `db:migrate`       | Builds the project, applies pending SQL migrations to the database in `DATABASE_URL`, and prints status |
| `db:seed`          | Builds the project and creates the development platform administrator key, printed once (see Demonstration) |

`pnpm db:migrate` is safe to run repeatedly: applied migrations are recorded and never run twice, and concurrent runs are serialized by a database lock. The first run on an empty database creates the `merchants` and `audit_events` tables, and later runs report `Nothing is pending.` It empties `apps/api/dist` when it builds, which can interrupt a `pnpm dev` that is restarting at that moment.

## API conventions

Business endpoints live under `/api/v1`; the health endpoints keep their paths, `/health/live` and `/health/ready`. The only business endpoints today are the merchant endpoints (see Merchant endpoints).

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
| `UNAUTHENTICATED`        | 401    | The API key is missing, malformed, unknown, wrong, or revoked                  |
| `INSUFFICIENT_ROLE`      | 403    | The API key is valid but its role does not allow the operation                 |
| `NOT_FOUND`              | 404    | Unknown route, unsupported method, or a resource the caller cannot see         |
| `MERCHANT_TRANSITION_NOT_ALLOWED` | 409 | The merchant's status cannot change to the requested one (including to itself) |
| `MERCHANT_STATUS_CONFLICT` | 409  | Another request changed the merchant's status first; nothing was changed       |
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

## Authentication

Every route requires an API key unless it is explicitly marked public. Send it as `Authorization: Bearer mfk_<lookup id>_<secret>`. The health probes and the OpenAPI document (outside production) need no key.

- A missing header, another scheme, a malformed key, an unknown key, a wrong secret, and a revoked key all receive the same `401` with code `UNAUTHENTICATED` and a `WWW-Authenticate: Bearer` header, so a caller cannot tell which case occurred.
- A valid key whose role a route does not accept receives `403` with code `INSUFFICIENT_ROLE`.
- Revocation is checked on every request and nothing is cached, so a revoked key stops working with its next request.
- A route that declares neither the roles it accepts nor that it is public is denied, even to a valid key.
- The merchant a request acts for comes only from the key, never from the path, query, body, or a header.
- A key of a `DRAFT` or `SUSPENDED` merchant still authenticates; what each status allows is decided by the command that runs, not by the guard.
- Logs record the key's row ID, role, and merchant ID, and never the key or any part of its secret.

## Configuration

The API reads its configuration from environment variables and refuses to start, with an error that names the invalid variable but never its value, when one is invalid.

| Variable       | Default       | Description                                                                        |
| -------------- | ------------- | ---------------------------------------------------------------------------------- |
| `NODE_ENV`     | `development` | Runtime mode: `development`, `test`, or `production`                               |
| `HOST`         | `127.0.0.1`   | Interface the API binds to; Compose sets `0.0.0.0` inside the `dev` container      |
| `PORT`         | `3000`        | TCP port the API listens on inside the container                                   |
| `LOG_LEVEL`    | `info`        | Minimum log level: `fatal`, `error`, `warn`, `info`, `debug`, `trace`, or `silent` |
| `DATABASE_URL` | none          | PostgreSQL connection URI; required, and never logged                              |

[`.env.example`](.env.example) is the reference for every variable. Docker Compose already sets `HOST` and `DATABASE_URL` for the `dev` container, so the quick start needs no `.env` file. To override a value, copy `.env.example` to `.env` in the repository root; `.env` is ignored by Git and must never be committed. The local database password defaults to a throwaway development value and can be changed with the `POSTGRES_PASSWORD` environment variable when running `docker compose`.

## Current limitations

- A request the JSON body parser rejects (malformed JSON, for instance) receives the standard error but writes no access log line.
- No rate limit, idempotency key, or input size limit beyond the parser's default exists yet. Creating a merchant twice creates two merchants.
- The only business endpoints are the merchant endpoints: there is no endpoint to list the keys of a merchant (a key can be revoked by the `id` returned when it was issued), and no platform key can be issued through the API; the development seed is the only way to create one, and a lost platform key is replaced by revoking it in the database (see Recover a lost platform key). Payments, processors, ledger, and dashboard are planned.
- The error responses of the health endpoints and of the unknown-route handler are not described in the OpenAPI document.
- A merchant created or changed by a transaction that commits late can be missed by a list walk already past its position; the next walk shows it.
- `api_keys` accepts only the `PLATFORM_ADMIN`, `MERCHANT_ADMIN`, and `MERCHANT_READ_ONLY` roles; rows can be revoked once and never removed or reactivated, through triggers that a database superuser or the table owner can still disable.
- `audit_events` rejects updates, deletes, and truncation through a trigger, which a database superuser or the table owner can still disable. Audit metadata must never hold secrets or payment credentials.
- The setup is verified on Docker Desktop only (see Prerequisites).
- The GitHub Actions workflow has not run on a hosted runner yet.
- There is no production build, deployment configuration, or container image for running the API outside development.
