// Pure policy for the server-side runner proxy. Nothing here touches the token.
const SEG = /^[a-zA-Z0-9_-]{1,80}$/;

export function runnerBase(env: Record<string, string | undefined>): string {
  return (env.RUNNER_URL?.trim() || 'http://127.0.0.1:4000').replace(/\/+$/, '');
}

/** Returns the runner path (e.g. /api/runs/x) or null when method/path is not allow-listed. */
export function resolveProxyTarget(method: string, segments: readonly string[]): string | null {
  if (method === 'GET' && segments.length === 4 && segments[0] === 'runs' && SEG.test(segments[1]) && segments[2] === 'artifacts' && /^[a-zA-Z0-9_-]+\.[a-zA-Z0-9]+$/.test(segments[3])) return `/api/${segments.join('/')}`;
  if (!segments.length || !segments.every(s => SEG.test(s))) return null;
  const [head, id, tail] = segments;
  const path = `/api/${segments.join('/')}`;
  const n = segments.length;
  if (method === 'GET') {
    if (n === 1 && ['health', 'capabilities', 'scenarios', 'context-packs', 'runs', 'investigations', 'applications', 'studies', 'study-executions', 'populations', 'population-executions'].includes(head)) return path;
    if (n === 2 && ['scenarios', 'context-packs', 'runs', 'investigations', 'studies', 'study-executions', 'populations', 'population-executions'].includes(head) && id) return path;
    if (n === 3 && head === 'runs' && tail === 'artifacts') return path;
    if (n === 3 && head === 'applications' && tail === 'context') return path;
    return null;
  }
  if (method === 'POST' && n === 3 && head === 'runs' && tail === 'replay') return path;
  if (method === 'POST' && head === 'studies' && ((n === 2 && id === 'generate') || (n === 3 && tail === 'launch'))) return path;
  if (method === 'POST' && n === 3 && head === 'populations' && tail === 'executions') return path;
  if (method === 'POST') return n === 1 && ['scenarios', 'context-packs', 'runs', 'investigations', 'populations'].includes(head) ? path : null;
  if (method === 'PUT') return n === 2 && ['scenarios', 'context-packs', 'studies'].includes(head) ? path : null;
  return null;
}

// The local dashboard is served on port 3000. Do not trust client-supplied
// Host/Origin pairs merely because they agree with each other.
const DASHBOARD_ORIGINS = ['http://localhost:3000', 'http://127.0.0.1:3000'];

export function isTrustedDashboardHost(headers: Headers): boolean {
  const host = headers.get('host');
  return DASHBOARD_ORIGINS.some(origin => new URL(origin).host === host);
}

export function isSameOriginWrite(headers: Headers): boolean {
  const origin = headers.get('origin');
  return origin !== null && DASHBOARD_ORIGINS.includes(origin)
    && new URL(origin).host === headers.get('host');
}
