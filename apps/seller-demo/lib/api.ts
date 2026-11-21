import { timingSafeEqual } from 'node:crypto';
import { FIXTURES, NotFoundError, SellerStore, ValidationError, type FixtureId } from './store';

export const SESSION_COOKIE = 'seller_session';
type Env = Record<string, string | undefined>;

const reply = (status: number, body: unknown, headers?: Record<string, string>) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers } });
const fail = (status: number, code: string, message: string) => reply(status, { code, message });

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const v = await req.json();
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch { return null; }
}

function cookieValue(req: Request, name: string): string | null {
  for (const part of (req.headers.get('cookie') ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return null; }
    }
  }
  return null;
}

const same = (a: string, b: string) => {
  const left = Buffer.from(a); const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

export function createApi({ store, env }: { store: SellerStore; env: Env }) {
  const testEnabled = () => env.ENABLE_TEST_API === 'true';
  const testToken = () => env.TEST_API_TOKEN || (env.NODE_ENV === 'production' ? '' : 'local-development-test');
  /** Returns a Response when the request must be rejected, otherwise null. */
  function guardTest(req: Request): Response | null {
    if (!testEnabled()) return fail(404, 'not_found', 'Not found');
    const expected = testToken();
    const m = /^Bearer (.+)$/.exec(req.headers.get('authorization') ?? '');
    if (!expected || !m || !same(m[1], expected)) return fail(401, 'unauthorized', 'Missing or invalid test token');
    return null;
  }
  const guarded = (fn: (req: Request) => Promise<Response> | Response) => async (req: Request) => {
    try { return await fn(req); } catch (e) {
      if (e instanceof ValidationError) return fail(400, 'validation_error', e.message);
      if (e instanceof NotFoundError) return fail(404, 'not_found', e.message);
      throw e;
    }
  };
  const session = (req: Request) => {
    const token = cookieValue(req, SESSION_COOKIE);
    return token ? store.resolveSession(token) : null;
  };
  const withSession = (fn: (ns: string, req: Request) => Promise<Response> | Response) => guarded((req) => {
    const ns = session(req);
    return ns ? fn(ns, req) : fail(401, 'unauthorized', 'No demo session. Start a demo session first.');
  });

  return {
    testSessions: guarded(async (req) => {
      const denied = guardTest(req); if (denied) return denied;
      const body = await readJson(req);
      const fixtureId = body?.fixtureId;
      if (!FIXTURES.includes(fixtureId as FixtureId)) return fail(400, 'validation_error', "fixtureId must be 'fresh-seller' or 'active-seller'");
      const { namespaceId, token } = store.createSession(fixtureId as FixtureId);
      return reply(201, { namespaceId, cookie: { name: SESSION_COOKIE, value: token, path: '/' } });
    }),
    testState: guarded((req) => {
      const denied = guardTest(req); if (denied) return denied;
      const ns = new URL(req.url).searchParams.get('namespaceId');
      if (!ns) return fail(400, 'validation_error', 'namespaceId is required');
      return reply(200, store.getState(ns));
    }),
    testBuild: guarded((req) => {
      const denied = guardTest(req); if (denied) return denied;
      return reply(200, { buildId: env.SELLER_BUILD_ID || 'seller-demo-local' });
    }),
    /** Public local-demo flow: creates an isolated namespace and sets an HttpOnly cookie. */
    startSession: guarded(async (req) => {
      const body = (await readJson(req)) ?? {};
      const fixtureId = body.fixtureId ?? 'fresh-seller';
      if (!FIXTURES.includes(fixtureId as FixtureId)) return fail(400, 'validation_error', "fixtureId must be 'fresh-seller' or 'active-seller'");
      const { token } = store.createSession(fixtureId as FixtureId);
      const secure = env.NODE_ENV === 'production' ? '; Secure' : '';
      return reply(201, { started: true }, { 'set-cookie': `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax${secure}` });
    }),
    getStore: withSession((ns) => reply(200, { store: store.getState(ns).store })),
    putStore: withSession(async (ns, req) => {
      const body = await readJson(req);
      if (!body) return fail(400, 'validation_error', 'Send a JSON object with a name');
      return reply(200, { store: store.saveStoreName(ns, body.name) });
    }),
    getInventory: withSession((ns) => reply(200, { inventory: store.getState(ns).inventory })),
    putInventory: withSession(async (ns, req) => {
      const body = await readJson(req);
      if (!body) return fail(400, 'validation_error', 'Send a JSON object with sku and quantity');
      return reply(200, { inventory: store.saveQuantity(ns, body.sku, body.quantity) });
    }),
  };
}
