import type { Hono } from 'hono';
import type { AppEnv } from '../env';

/**
 * Internal requests of the agent MCP endpoint (HeoPress P10): a tool call runs as a request to the REST API the
 * Studio uses, so every guard on that path applies. The person it runs as is attached to the `Request` object here —
 * never to a header, so nothing from outside can claim it — and `withAuth` picks it up.
 */

export interface DispatchedPerson {
  userId: string;
  grantId: string | null;
}

const people = new WeakMap<Request, DispatchedPerson>();
let target: Hono<AppEnv> | null = null;

/** Called once by the application (`index.ts`) with itself. */
export function setAgentDispatchApp(app: Hono<AppEnv>): void {
  target = app;
}

/** Send `request` through the whole application as `person` (or with its own Authorization header when null). */
export async function dispatchAsAgent(request: Request, person: DispatchedPerson | null, env: AppEnv['Bindings']): Promise<Response> {
  if (!target) throw new Error('agent dispatch: application not registered');
  if (person) people.set(request, person);
  return target.fetch(request, env);
}

/** The person an internal request runs as, or undefined for every request from outside. */
export function dispatchedPersonOf(request: Request): DispatchedPerson | undefined {
  return people.get(request);
}
