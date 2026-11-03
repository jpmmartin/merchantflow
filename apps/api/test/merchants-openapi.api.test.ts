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
  properties?: Record<string, SchemaObject>;
  required?: string[];
  additionalProperties?: boolean;
  maximum?: number;
  minimum?: number;
  default?: unknown;
}

interface Operation {
  summary?: string;
  description?: string;
  security?: Record<string, string[]>[];
  parameters?: {
    name: string;
    in: string;
    required: boolean;
    schema: SchemaObject;
  }[];
  requestBody?: { content: { 'application/json': { schema: SchemaObject } } };
  responses: Record<
    string,
    {
      description: string;
      content?: { 'application/json': { schema: SchemaObject } };
    }
  >;
}

interface OpenApiDocument {
  paths: Record<string, Record<string, Operation>>;
  components: { securitySchemes: Record<string, Record<string, string>> };
}

const ENDPOINTS: ReadonlyArray<
  readonly [string, string, string, readonly string[]]
> = [
  ['post', '/api/v1/merchants', '201', ['400', '401', '403']],
  ['get', '/api/v1/merchants', '200', ['400', '401']],
  ['get', '/api/v1/merchants/{id}', '200', ['400', '401', '404']],
  ['patch', '/api/v1/merchants/{id}', '200', ['400', '401', '403', '404']],
  [
    'post',
    '/api/v1/merchants/{id}/status',
    '200',
    ['400', '401', '403', '404', '409'],
  ],
  [
    'post',
    '/api/v1/merchants/{id}/api-keys',
    '201',
    ['400', '401', '403', '404'],
  ],
  [
    'post',
    '/api/v1/merchants/{id}/api-keys/{apiKeyId}/revoke',
    '200',
    ['400', '401', '403', '404'],
  ],
];

describe('OpenAPI document of the merchant endpoints', () => {
  let app: INestApplication;
  let server: Server;
  let document: OpenApiDocument;

  beforeAll(async () => {
    ({ app, server } = await startApp(UNREACHABLE_DATABASE_URL));
    const response = await request(server).get('/docs/openapi.json');
    document = response.body as OpenApiDocument;
  });

  afterAll(async () => {
    await app.close();
  });

  const operation = (method: string, path: string): Operation => {
    const found = document.paths[path]?.[method];
    if (found === undefined) throw new Error(`${method} ${path} is missing`);
    return found;
  };

  it('declares the Bearer security scheme', () => {
    expect(document.components.securitySchemes['bearer']).toMatchObject({
      type: 'http',
      scheme: 'bearer',
    });
  });

  it.each(ENDPOINTS)(
    '%s %s requires the Bearer scheme and documents %s and its errors',
    (method, path, success, failures) => {
      const found = operation(method, path);

      expect(found.security).toEqual([{ bearer: [] }]);
      expect(found.summary).toBeTruthy();
      expect(found.description).toMatch(/Roles?:/);
      expect(Object.keys(found.responses)).toEqual(
        expect.arrayContaining([success, ...failures]),
      );
      for (const status of [success, ...failures]) {
        expect(
          found.responses[status]?.content?.['application/json']?.schema.type,
        ).toBe('object');
      }
    },
  );

  it('keeps the health probes outside the security requirement', () => {
    expect(operation('get', '/health/live').security).toBeUndefined();
    expect(operation('get', '/health/ready').security).toBeUndefined();
  });

  it('names the roles of each operation', () => {
    expect(operation('post', '/api/v1/merchants').description).toContain(
      'PLATFORM_ADMIN',
    );
    expect(operation('patch', '/api/v1/merchants/{id}').description).toContain(
      'MERCHANT_ADMIN',
    );
    expect(
      operation('post', '/api/v1/merchants/{id}/status').description,
    ).toContain('PLATFORM_ADMIN only');
  });

  it('generates strict request body schemas from the Zod schemas', () => {
    const create = operation('post', '/api/v1/merchants').requestBody?.content[
      'application/json'
    ].schema;
    const status = operation('post', '/api/v1/merchants/{id}/status')
      .requestBody?.content['application/json'].schema;
    const key = operation('post', '/api/v1/merchants/{id}/api-keys').requestBody
      ?.content['application/json'].schema;
    const patch = operation('patch', '/api/v1/merchants/{id}').requestBody
      ?.content['application/json'].schema;

    expect(create?.additionalProperties).toBe(false);
    expect(create?.required).toEqual([
      'legal_name',
      'display_name',
      'business_type',
      'industry',
      'country_code',
      'default_currency',
    ]);
    expect(status?.additionalProperties).toBe(false);
    expect(status?.properties?.['status']?.enum).toEqual([
      'DRAFT',
      'ACTIVE',
      'SUSPENDED',
    ]);
    expect(key?.properties?.['role']?.enum).toEqual([
      'MERCHANT_ADMIN',
      'MERCHANT_READ_ONLY',
    ]);
    expect(patch?.additionalProperties).toBe(false);
    expect(patch?.required).toBeUndefined();
    expect(Object.keys(patch?.properties ?? {})).toEqual([
      'legal_name',
      'display_name',
      'business_type',
      'industry',
      'country_code',
      'status',
      'default_currency',
    ]);
  });

  it('documents the path parameters and the pagination query', () => {
    const list = operation('get', '/api/v1/merchants').parameters ?? [];
    const revoke =
      operation('post', '/api/v1/merchants/{id}/api-keys/{apiKeyId}/revoke')
        .parameters ?? [];

    expect(list.map((parameter) => [parameter.name, parameter.in])).toEqual([
      ['limit', 'query'],
      ['cursor', 'query'],
    ]);
    const limit = list.find((parameter) => parameter.name === 'limit');
    expect(limit?.schema).toMatchObject({
      type: 'integer',
      minimum: 1,
      maximum: 100,
      default: 20,
    });
    expect(revoke.map((parameter) => [parameter.name, parameter.in])).toEqual([
      ['id', 'path'],
      ['apiKeyId', 'path'],
    ]);
  });

  it('describes the responses, the one-time key, and every error code', () => {
    const issued = operation('post', '/api/v1/merchants/{id}/api-keys')
      .responses['201']?.content?.['application/json'].schema;
    const list = operation('get', '/api/v1/merchants').responses['200']
      ?.content?.['application/json'].schema;
    const conflict = operation('post', '/api/v1/merchants/{id}/status')
      .responses['409']?.content?.['application/json'].schema;

    expect(Object.keys(issued?.properties ?? {}).sort()).toEqual([
      'created_at',
      'id',
      'key',
      'merchant_id',
      'role',
    ]);
    expect(Object.keys(list?.properties ?? {}).sort()).toEqual([
      'data',
      'next_cursor',
    ]);
    const codes = conflict?.properties?.['error']?.properties?.['code']?.enum;
    expect(codes).toEqual([...ERROR_CODES]);
    expect(codes).toEqual(
      expect.arrayContaining([
        'MERCHANT_TRANSITION_NOT_ALLOWED',
        'MERCHANT_STATUS_CONFLICT',
      ]),
    );
    expect(
      operation('post', '/api/v1/merchants/{id}/api-keys').description,
    ).toContain('no-store');
  });

  it('never lists a hash or a lookup id in any schema', () => {
    const text = JSON.stringify(document);

    expect(text).not.toContain('secret_hash');
    expect(text).not.toContain('lookup_id');
  });
});
