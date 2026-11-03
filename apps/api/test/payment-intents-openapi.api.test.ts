import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ERROR_CODES } from '../src/modules/errors/api/error-codes.js';
import { startApp } from './support/start-app.js';

// Nothing listens on this port: the document is built without a database.
const UNREACHABLE_DATABASE_URL =
  'postgresql://nobody:placeholder@127.0.0.1:1/placeholder';

interface SchemaObject {
  type?: string;
  enum?: string[];
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  properties?: Record<string, SchemaObject>;
  required?: string[];
  additionalProperties?: boolean;
}

interface Operation {
  summary?: string;
  description?: string;
  security?: Record<string, string[]>[];
  parameters?: {
    name: string;
    in: string;
    required?: boolean;
    schema?: SchemaObject;
  }[];
  requestBody?: { content: { 'application/json': { schema: SchemaObject } } };
  responses: Record<
    string,
    {
      description: string;
      headers?: Record<string, { schema?: SchemaObject }>;
      content?: { 'application/json': { schema: SchemaObject } };
    }
  >;
}

interface OpenApiDocument {
  paths: Record<string, Record<string, Operation>>;
}

describe('OpenAPI document of POST /payment-intents', () => {
  let app: INestApplication;
  let server: Server;
  let operation: Operation;

  beforeAll(async () => {
    ({ app, server } = await startApp(UNREACHABLE_DATABASE_URL));
    const response = await request(server).get('/docs/openapi.json');
    const document = response.body as OpenApiDocument;
    const found = document.paths['/api/v1/payment-intents']?.['post'];
    if (found === undefined)
      throw new Error('POST /payment-intents is missing');
    operation = found;
  });

  afterAll(async () => {
    await app.close();
  });

  it('requires the Bearer scheme and names the role', () => {
    expect(operation.security).toEqual([{ bearer: [] }]);
    expect(operation.summary).toBeTruthy();
    expect(operation.description).toContain('Roles: MERCHANT_ADMIN');
  });

  it('documents the required Idempotency-Key header and its format', () => {
    const header = operation.parameters?.find(
      (parameter) => parameter.name === 'Idempotency-Key',
    );

    expect(header).toMatchObject({
      in: 'header',
      required: true,
      schema: {
        type: 'string',
        minLength: 1,
        maxLength: 255,
        pattern: '^[!-~]{1,255}$',
      },
    });
  });

  it('generates a strict request body from the Zod schema', () => {
    const body = operation.requestBody?.content['application/json'].schema;

    expect(body?.additionalProperties).toBe(false);
    expect(body?.required).toEqual([
      'amount_minor',
      'currency',
      'merchant_reference',
    ]);
    expect(body?.properties?.['amount_minor']?.type).toBe('string');
    expect(body?.properties?.['currency']?.enum).toEqual(['USD']);
    expect(body?.properties?.['merchant_reference']?.pattern).toBe(
      '^[!-~]{1,128}$',
    );
  });

  it('documents the 201 response and every error with the shared error shape', () => {
    expect(Object.keys(operation.responses).sort()).toEqual([
      '201',
      '400',
      '401',
      '403',
      '409',
      '422',
      '503',
    ]);
    const created =
      operation.responses['201']?.content?.['application/json'].schema;
    expect(Object.keys(created?.properties ?? {})).toEqual([
      'id',
      'merchant_id',
      'amount_minor',
      'currency',
      'merchant_reference',
      'status',
      'created_at',
      'updated_at',
    ]);
    expect(created?.properties?.['amount_minor']?.type).toBe('string');

    for (const status of ['400', '401', '403', '409', '422', '503']) {
      const schema =
        operation.responses[status]?.content?.['application/json'].schema;
      expect(schema?.properties?.['error']?.properties?.['code']?.enum).toEqual(
        [...ERROR_CODES],
      );
    }
  });

  it.each([
    [
      '400',
      [
        'IDEMPOTENCY_KEY_MISSING',
        'IDEMPOTENCY_KEY_INVALID',
        'VALIDATION_FAILED',
      ],
    ],
    ['403', ['INSUFFICIENT_ROLE', 'MERCHANT_NOT_ACTIVE']],
    [
      '409',
      [
        'IDEMPOTENCY_KEY_REUSED',
        'OPERATION_IN_PROGRESS',
        'DUPLICATE_MERCHANT_REFERENCE',
      ],
    ],
    ['422', ['MERCHANT_CURRENCY_MISMATCH']],
    ['503', ['OPERATION_TIMEOUT']],
  ])('names the codes of %s', (status, codes) => {
    const description = operation.responses[status]?.description ?? '';
    for (const code of codes) {
      expect(description).toContain(code);
      expect(ERROR_CODES).toContain(code);
    }
  });

  it('documents Retry-After on the 409 and 503 responses', () => {
    for (const status of ['409', '503']) {
      expect(
        operation.responses[status]?.headers?.['Retry-After']?.schema?.type,
      ).toBe('integer');
    }
  });
});
