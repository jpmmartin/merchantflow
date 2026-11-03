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
- database tables for merchants and an append-only audit trail, with the constraints enforced by PostgreSQL itself (storage only: there are no merchant endpoints yet);
- API key issuance and revocation inside the API code: keys carry 256 bits of randomness, only a lookup identifier and a SHA-256 hash are stored, and each issuance or revocation writes an audit event (no endpoint issues or revokes keys yet);
- request authentication: a global guard checks the `Authorization: Bearer <key>` header against the stored hash on every request, with deny-by-default routing and role checks (see Authentication). No business endpoint exists yet, so only the tests exercise it;
- linting, formatting, type checking, unit tests, and integration tests against a real PostgreSQL started with Testcontainers;
- a GitHub Actions workflow that runs the same checks.

Merchants, payments, and every other business capability are planned and do not exist yet.

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

`pnpm db:migrate` is safe to run repeatedly: applied migrations are recorded and never run twice, and concurrent runs are serialized by a database lock. The first run on an empty database creates the `merchants` and `audit_events` tables, and later runs report `Nothing is pending.` It empties `apps/api/dist` when it builds, which can interrupt a `pnpm dev` that is restarting at that moment.

## API conventions

Business endpoints will live under `/api/v1`; the health endpoints keep their paths, `/health/live` and `/health/ready`. No business endpoint exists yet.

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
| `REQUEST_REJECTED`       | 4xx    | Any other client error, with its own status                                    |
| `NOT_FOUND`              | 404    | Unknown route, unsupported method, or (later) a resource the caller cannot see |
| `PAYLOAD_TOO_LARGE`      | 413    | The body exceeds the parser's default limit                                    |
| `UNSUPPORTED_MEDIA_TYPE` | 415    | The body encoding is not supported                                             |
| `INTERNAL_ERROR`         | 500    | An unexpected failure; the cause is only in the server log                     |

The `/health/ready` answer is the exception: its `503` body stays `{"status":"unavailable"}`, because probes read the status.

Outside production (`NODE_ENV` other than `production`) the API serves its OpenAPI document at `GET /docs/openapi.json` and an interactive UI at `GET /docs`. In production neither exists.

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
- The OpenAPI document does not describe error responses yet, and no rate limit or input size limit beyond the parser's default exists.
- Only the foundation, the merchant, audit, and API key tables, and the key issuance and revocation code exist: no merchant endpoints, no endpoint to issue or revoke keys, payments, processors, ledger, or dashboard. These are planned.
- `api_keys` accepts only the `PLATFORM_ADMIN`, `MERCHANT_ADMIN`, and `MERCHANT_READ_ONLY` roles; rows can be revoked once and never removed or reactivated, through triggers that a database superuser or the table owner can still disable.
- `audit_events` rejects updates, deletes, and truncation through a trigger, which a database superuser or the table owner can still disable. Audit metadata must never hold secrets or payment credentials.
- The setup is verified on Docker Desktop only (see Prerequisites).
- The GitHub Actions workflow has not run on a hosted runner yet.
- There is no production build, deployment configuration, or container image for running the API outside development.
