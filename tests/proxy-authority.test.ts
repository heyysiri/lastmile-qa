import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET, POST } from '../apps/lastmile/app/api/runner/[...path]/route';
import { isSameOriginWrite, resolveProxyTarget } from '../apps/lastmile/lib/proxy-policy';

const context = { params: Promise.resolve({ path: ['runs'] }) };
const request = (method: string, host: string, origin?: string) => new Request('http://localhost:3000/api/runner/runs', {
  method, headers: { host, ...(origin ? { origin } : {}) }, ...(method === 'POST' ? { body: '{}' } : {}),
});
afterEach(() => vi.unstubAllGlobals());

describe('privileged proxy authority boundary', () => {
  it.each(['localhost:3000', '127.0.0.1:3000'])('allows the configured local authority %s', async host => {
    vi.stubGlobal('fetch', async () => Response.json({ runs: [] }));
    expect((await GET(request('GET', host), context)).status).toBe(200);
    expect((await POST(request('POST', host, `http://${host}`), context)).status).toBe(200);
  });

  it.each(['untrusted.example:3000', 'localhost:3001', 'localhost:3000.evil.example'])('rejects unexpected host %s on reads and matching-origin writes', async host => {
    vi.stubGlobal('fetch', async () => Response.json({ runs: [] }));
    expect((await GET(request('GET', host), context)).status).toBe(403);
    expect((await POST(request('POST', host, `http://${host}`), context)).status).toBe(403);
  });

  it.each(['https://localhost:3000', 'http://127.0.0.1:3000', 'http://localhost:3000/path', 'null'])('rejects a nonmatching full write origin %s', async origin => {
    vi.stubGlobal('fetch', async () => Response.json({ runs: [] }));
    expect(isSameOriginWrite(new Headers({ host: 'localhost:3000', origin }))).toBe(false);
    expect((await POST(request('POST', 'localhost:3000', origin), context)).status).toBe(403);
  });
});

it('allows only safe artifact filenames on the read route',()=>{
 expect(resolveProxyTarget('GET',['runs','run-id','artifacts','final.png'])).toBe('/api/runs/run-id/artifacts/final.png');
 expect(resolveProxyTarget('GET',['runs','run-id','artifacts','..%2fsecret'])).toBeNull();
 expect(resolveProxyTarget('POST',['runs','run-id','artifacts','final.png'])).toBeNull();
 expect(resolveProxyTarget('POST',['investigations'])).toBe('/api/investigations');
});
