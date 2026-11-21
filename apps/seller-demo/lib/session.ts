import { cookies } from 'next/headers';
import { SESSION_COOKIE } from './api';
import { runtime } from './runtime';

/** Server-side read of the current visitor's persisted state; null without a valid session. */
export async function currentState() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const { store } = runtime();
  const ns = token ? store.resolveSession(token) : null;
  return ns ? store.getState(ns) : null;
}
