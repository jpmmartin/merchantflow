import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProbeController } from './support/probe.controller.js';
import { startApp } from './support/start-app.js';

const UNREACHABLE_DATABASE_URL =
  'postgresql://nobody:placeholder@127.0.0.1:1/placeholder';

interface SchemaObject {
  type?: string;
  minLength?: number;
  properties?: Record<string, SchemaObject>;
  required?: string[];
  enum?: string[];
  additionalProperties?: boolean;
  $ref?: string;
}

interface OpenApiDocument {
  openapi: string;
  info: { title: string };
  paths: Record<string, Record<string, unknown>>;
}

describe('OpenAPI document outside production', () => {
  let app: INestApplication;
  let server: Server;
  let document: OpenApiDocument;

  beforeAll(async () => {
    ({ app, server } = await startApp(UNREACHABLE_DATABASE_URL, {
      controllers: [ProbeController],
    }));
    const response = await request(server).get('/docs/openapi.json');
    document = response.body as OpenApiDocument;
  });

  afterAll(async () => {
    await app.close();
  });

  it('serves the document as JSON', async () => {
    const response = await request(server).get('/docs/openapi.json');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/application\/json/);
    expect(document.openapi).toMatch(/^3\./);
    expect(document.info.title).toBe('MerchantFlow API');
  });

  it('serves the interactive UI', async () => {
    const response = await request(server).get('/docs');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/text\/html/);
    expect(response.text).toContain('swagger-ui');
  });

  it('generates the request body schema from the Zod schema', () => {
    const operation = document.paths['/api/v1/probe/items']?.['post'] as {
      requestBody: {
        content: { 'application/json': { schema: SchemaObject } };
      };
    };

    const schema = operation.requestBody.content['application/json'].schema;
    expect(schema.type).toBe('object');
    expect(schema.properties?.['name']).toMatchObject({
      type: 'string',
      minLength: 30,
    });
    expect(schema.properties?.['quantity']?.type).toBe('integer');
    expect(schema.properties?.['kind']?.enum).toEqual(['physical', 'digital']);
    expect(schema.required).toEqual(['name', 'quantity', 'kind']);
    expect(schema.additionalProperties).toBe(false);
  });

  it('lists the prefixed business route and the unprefixed health routes', () => {
    expect(Object.keys(document.paths)).toEqual(
      expect.arrayContaining([
        '/api/v1/probe/items',
        '/api/v1/probe/items/{id}',
        '/health/live',
        '/health/ready',
      ]),
    );
  });

  it('documents query and route parameters taken from Zod schemas', () => {
    const operation = document.paths['/api/v1/probe/items/{id}']?.['get'] as {
      parameters: { name: string; in: string }[];
    };

    expect(operation.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'id', in: 'path' }),
        expect.objectContaining({ name: 'limit', in: 'query' }),
      ]),
    );
  });
});
