import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import type { INestApplication, Type } from '@nestjs/common';
import { RequestMethod } from '@nestjs/common';
import { ModulesContainer, Reflector } from '@nestjs/core';
import { Public, Roles } from '../../src/modules/auth/api/route-access.js';
import type { ApiKeyRole } from '../../src/modules/auth/application/api-key-scope.js';

export interface DiscoveredRoute {
  /** `METHOD /path` below the global prefix, with Nest's `:param` names. */
  readonly route: string;
  readonly controller: string;
  readonly handler: string;
  readonly isPublic: boolean;
  readonly roles: readonly ApiKeyRole[] | undefined;
}

export type RouteClass = 'public' | 'platform-only' | 'tenant' | 'unclassified';

function pathsOf(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.map(String);
  return [''];
}

function joinPath(controllerPath: string, handlerPath: string): string {
  const segments = [controllerPath, handlerPath]
    .flatMap((part) => part.split('/'))
    .filter((segment) => segment.length > 0);
  return `/${segments.join('/')}`;
}

/**
 * Every route the running application serves, read from the same metadata Nest
 * routes with and the authentication guard reads: the controller and method
 * decorators, `@Roles`, and `@Public`.
 */
export function discoverRoutes(app: INestApplication): DiscoveredRoute[] {
  const reflector = app.get(Reflector);
  const routes: DiscoveredRoute[] = [];
  for (const module of app.get(ModulesContainer).values()) {
    for (const wrapper of module.controllers.values()) {
      const controller = wrapper.metatype as Type | null;
      if (controller === null || wrapper.instance === null) continue;
      const prototype = controller.prototype as Record<string, unknown>;
      for (const name of Object.getOwnPropertyNames(prototype)) {
        const handler = prototype[name];
        if (typeof handler !== 'function') continue;
        const method: unknown = Reflect.getMetadata(METHOD_METADATA, handler);
        if (typeof method !== 'number') continue;
        const verb = RequestMethod[method];
        const controllerPaths = pathsOf(
          Reflect.getMetadata(PATH_METADATA, controller),
        );
        const handlerPaths = pathsOf(
          Reflect.getMetadata(PATH_METADATA, handler),
        );
        const targets = [handler, controller];
        for (const controllerPath of controllerPaths) {
          for (const handlerPath of handlerPaths) {
            routes.push({
              route: `${verb} ${joinPath(controllerPath, handlerPath)}`,
              controller: controller.name,
              handler: name,
              isPublic: reflector.getAllAndOverride(Public, targets) === true,
              roles: reflector.getAllAndOverride(Roles, targets),
            });
          }
        }
      }
    }
  }
  return routes;
}

/**
 * Puts a route in exactly one class. A route that is neither public, nor
 * restricted to `PLATFORM_ADMIN`, nor listed as tenant-scoped is `unclassified`:
 * its tenant behaviour has no test.
 */
export function classifyRoute(
  route: DiscoveredRoute,
  tenantRoutes: ReadonlySet<string>,
): RouteClass {
  if (route.isPublic) return 'public';
  if (tenantRoutes.has(route.route)) return 'tenant';
  if (route.roles?.length === 1 && route.roles[0] === 'PLATFORM_ADMIN') {
    return 'platform-only';
  }
  return 'unclassified';
}
