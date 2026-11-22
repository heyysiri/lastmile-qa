import { afterEach, expect, it, vi } from 'vitest';
const { readClerkUserId } = vi.hoisted(() => ({ readClerkUserId: vi.fn() }));
import { createDashboardProxy } from '../apps/lastmile/lib/dashboard-proxy';
const GET = createDashboardProxy(readClerkUserId);
const PUT = GET;
import { dashboardAuthMode } from '../apps/lastmile/lib/dashboard-auth';
const context = { params: Promise.resolve({ path: ['settings', 'github'] }) };
const request = (method='GET') => new Request('http://localhost:3000/api/runner/settings/github', {
 method, headers: {host:'localhost:3000',origin:'http://localhost:3000','x-lastmile-user-id':'user_attacker'},
 ...(method==='PUT'?{body:JSON.stringify({token:'test_only'})}:{}),
});
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();vi.clearAllMocks();});
function configured(){vi.stubEnv('LASTMILE_AUTH','clerk');vi.stubEnv('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY','pk_test_fixture');vi.stubEnv('CLERK_SECRET_KEY','sk_test_fixture');}
it('allows keyless local development but fails closed on public or incomplete auth configuration',()=>{
 expect(dashboardAuthMode({})).toBe('local');
 expect(dashboardAuthMode({DASHBOARD_ORIGIN:'https://qa.test'})).toBe('unconfigured');
 expect(dashboardAuthMode({LASTMILE_AUTH:'clerk'})).toBe('unconfigured');
 expect(dashboardAuthMode({NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY:'pk_test_only'})).toBe('unconfigured');
 expect(dashboardAuthMode({LASTMILE_AUTH:'local',DASHBOARD_ORIGIN:'https://qa.test'})).toBe('unconfigured');
 expect(dashboardAuthMode({LASTMILE_AUTH:'clerk',NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY:'pk_test_a',CLERK_SECRET_KEY:'sk_test_a'})).toBe('clerk');
});
it('denies unauthenticated reads and writes before contacting the runner',async()=>{
 configured();readClerkUserId.mockResolvedValue(null);const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
 expect((await GET(request(),context)).status).toBe(401);
 expect((await PUT(request('PUT'),context)).status).toBe(401);
 expect(fetcher).not.toHaveBeenCalled();
});
it('forwards only verified identity, never a browser-provided workspace header',async()=>{
 configured();readClerkUserId.mockResolvedValue('user_verified');
 const fetcher=vi.fn().mockResolvedValue(Response.json({configured:false,source:'none'}));vi.stubGlobal('fetch',fetcher);
 expect((await GET(request(),context)).status).toBe(200);
 const headers=fetcher.mock.calls[0][1].headers as Headers;
 expect(headers.get('x-lastmile-user-id')).toBe('user_verified');
 expect(headers.get('cookie')).toBeNull();
});
it('denies access on Clerk verification error instead of falling back to the local workspace',async()=>{
 configured();readClerkUserId.mockRejectedValue(new Error('private provider detail'));
 const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);const response=await GET(request(),context);
 expect(response.status).toBe(503);expect(await response.text()).not.toContain('private provider detail');expect(fetcher).not.toHaveBeenCalled();
});
it('does not expose local runner data when Clerk keys are missing',async()=>{
 vi.stubEnv('LASTMILE_AUTH','clerk');vi.stubEnv('CLERK_SECRET_KEY','');vi.stubEnv('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY','');
 const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);expect((await GET(request(),context)).status).toBe(503);expect(fetcher).not.toHaveBeenCalled();
});
