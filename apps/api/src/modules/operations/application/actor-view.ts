import type { AuditActorType } from '../../audit/application/audit-event.js';
import type {
  ApiKeyRole,
  ApiKeyScope,
} from '../../auth/application/api-key-scope.js';
import type {
  ActorDirectory,
  UserActor,
} from '../../auth/application/describe-actors.service.js';
import type { Principal } from '../../auth/application/principal.js';

/** The label of every action of the platform for a merchant viewer. */
export const PLATFORM_ADMINISTRATOR_LABEL = 'Platform administrator';

/**
 * Who did something, as a reader may see it. `label` is ready to display.
 * A platform actor is `PLATFORM_ADMINISTRATOR`, with no email or ID, for a
 * merchant viewer; `UNKNOWN` is an actor whose user or key no longer exists
 * (or does not belong to the viewer's merchant), with its ID only for the
 * platform administrator.
 */
export type ActorView =
  | {
      readonly type: 'USER';
      readonly label: string;
      readonly userId: string;
      readonly displayName: string;
      readonly email: string;
    }
  | {
      readonly type: 'API_KEY';
      readonly label: string;
      readonly apiKeyId: string;
      readonly role: ApiKeyRole;
    }
  | {
      readonly type: 'SYSTEM';
      readonly label: string;
      readonly component: string;
    }
  | { readonly type: 'PLATFORM_ADMINISTRATOR'; readonly label: string }
  | {
      readonly type: 'UNKNOWN';
      readonly label: string;
      readonly actorType: AuditActorType;
      readonly actorId: string | null;
    };

/** The actors of a set of events, for one lookup in the auth module. */
export function actorRefsOf(
  actors: Iterable<{
    readonly actorType: AuditActorType;
    readonly actorId: string;
  }>,
): { userIds: string[]; apiKeyIds: string[] } {
  const userIds: string[] = [];
  const apiKeyIds: string[] = [];
  for (const actor of actors) {
    if (actor.actorType === 'USER') userIds.push(actor.actorId);
    if (actor.actorType === 'API_KEY') apiKeyIds.push(actor.actorId);
  }
  return { userIds, apiKeyIds };
}

/**
 * What a viewer may see of an actor of a scope. The platform administrator
 * sees every actor; a merchant viewer sees only actors of its own merchant,
 * and a platform actor appears to it as the platform administrator.
 */
type Visibility = 'SHOWN' | 'PLATFORM' | 'HIDDEN';

function visibilityOf(viewer: Principal, scope: ApiKeyScope): Visibility {
  if (viewer.kind === 'PLATFORM') return 'SHOWN';
  if (scope.kind === 'PLATFORM') return 'PLATFORM';
  return scope.merchantId === viewer.merchantId ? 'SHOWN' : 'HIDDEN';
}

function unknown(
  viewer: Principal,
  actorType: AuditActorType,
  actorId: string,
): ActorView {
  return {
    type: 'UNKNOWN',
    label: actorType === 'USER' ? 'Unknown user' : 'Unknown API key',
    actorType,
    actorId: viewer.kind === 'PLATFORM' ? actorId : null,
  };
}

function userView(user: UserActor): ActorView {
  return {
    type: 'USER',
    label: `${user.displayName} <${user.email}>`,
    userId: user.id,
    displayName: user.displayName,
    email: user.email,
  };
}

/** The view of a found user or key, according to what the viewer may see. */
function scopedView(
  viewer: Principal,
  actor: { readonly actorType: AuditActorType; readonly actorId: string },
  scope: ApiKeyScope,
  shown: () => ActorView,
): ActorView {
  switch (visibilityOf(viewer, scope)) {
    case 'SHOWN':
      return shown();
    case 'PLATFORM':
      return {
        type: 'PLATFORM_ADMINISTRATOR',
        label: PLATFORM_ADMINISTRATOR_LABEL,
      };
    case 'HIDDEN':
      return unknown(viewer, actor.actorType, actor.actorId);
  }
}

/** The readable actor of an event for a viewer. */
export function actorViewOf(
  actor: { readonly actorType: AuditActorType; readonly actorId: string },
  directory: ActorDirectory,
  viewer: Principal,
): ActorView {
  switch (actor.actorType) {
    case 'SYSTEM':
      return {
        type: 'SYSTEM',
        label: `System (${actor.actorId})`,
        component: actor.actorId,
      };
    case 'USER': {
      const user = directory.users.get(actor.actorId);
      if (user === undefined) return unknown(viewer, 'USER', actor.actorId);
      return scopedView(viewer, actor, user.scope, () => userView(user));
    }
    case 'API_KEY': {
      const key = directory.apiKeys.get(actor.actorId);
      if (key === undefined) return unknown(viewer, 'API_KEY', actor.actorId);
      return scopedView(viewer, actor, key.scope, () => ({
        type: 'API_KEY',
        label: `API key ${key.id} (${key.scope.role})`,
        apiKeyId: key.id,
        role: key.scope.role,
      }));
    }
  }
}
