import { dashboardAuthMode } from './dashboard-auth';
import { isTrustedDashboardHost, isSameOriginWrite, resolveProxyTarget, runnerBase } from './proxy-policy';

function err(status: number, code: string, message: string) {
  return Response.json({ code, message }, { status });
}

export function createDashboardProxy(readClerkUserId: () => Promise<string | null>) {
  return async function handle(req: Request, ctx: { params: Promise<{ path: string[] }> }): Promise<Response> {
    if (!isTrustedDashboardHost(req.headers)) return err(403, 'untrusted_host', 'Requests must use the configured dashboard host.');
    const mode = dashboardAuthMode();
    if (mode === 'unconfigured') return err(503, 'auth_unconfigured', 'Sign-in is not configured. Contact the workspace administrator.');
    let userId: string | null = null;
    if (mode === 'clerk') {
      try { userId = await readClerkUserId(); }
      catch { return err(503, 'auth_unavailable', 'Could not verify your session. Please sign in again.'); }
      if (!userId) return err(401, 'sign_in_required', 'Sign in to access your workspace.');
    }
    const { path } = await ctx.params;
    const method = req.method.toUpperCase();
    const target = resolveProxyTarget(method, path);
    if (!target) return err(404, 'not_proxied', `${method} /${path.join('/')} is not an allowed dashboard route.`);
    if (method !== 'GET' && !isSameOriginWrite(req.headers)) return err(403, 'cross_origin', 'Write requests must come from the dashboard origin.');

    const url = new URL(req.url);
    const base = runnerBase(process.env);
    const headers = new Headers({ authorization: `Bearer ${process.env.RUNNER_API_TOKEN || 'local-development-runner'}` });
    if (userId) headers.set('x-lastmile-user-id', userId);
    let body: string | undefined;
    if (method === 'POST' || method === 'PUT') {
      body = await req.text();
      headers.set('content-type', 'application/json');
    }
    try {
      // Generation includes browser observations and a bounded provider call.
      const timeout = method === 'POST' && target === '/api/studies/generate' ? 120_000 : 15_000;
      const upstream = await fetch(`${base}${target}${url.search}`, { method, headers, body, cache: 'no-store', signal: AbortSignal.timeout(timeout) });
      const data = await upstream.arrayBuffer();
      return new Response(data, { status: upstream.status, headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/json', 'cache-control': 'no-store' } });
    } catch (e) {
      const reason = e instanceof Error ? (e.cause instanceof Error ? e.cause.message : e.message) : String(e);
      return err(502, 'runner_offline', `Could not reach the runner at ${base} (${reason}). Start it with the dev script and retry.`);
    }
  }

}
