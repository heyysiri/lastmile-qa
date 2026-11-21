import { describe, expect, it } from 'vitest';
import { resolveProxyTarget } from '../apps/lastmile/lib/proxy-policy';

describe('dashboard project proxy', () => {
  it.each([
    ['GET', 'projects'], ['POST', 'projects'], ['GET', 'projects/by-request/connect-1'],
    ['GET', 'projects/desk'], ['POST', 'projects/desk/refresh'], ['POST', 'projects/desk/runs'],
    ['GET', 'project-runs/run-1'], ['GET', 'project-repairs'], ['POST', 'project-repairs'],
    ['GET', 'project-repairs/fix-1'], ['POST', 'project-repairs/fix-1/verify'],
  ])('allows %s %s', (method, path) => {
    expect(resolveProxyTarget(method, path.split('/'))).toBe(`/api/${path}`);
  });

  it.each([
    ['PUT', 'projects/desk'], ['GET', 'projects/desk/runs'], ['POST', 'project-runs/run-1'],
    ['POST', 'projects/by-request/connect-1'], ['GET', 'projects/by-request'],
    ['POST', 'project-repairs/fix-1/apply'], ['GET', 'project-repairs/fix-1/verify'],
    ['POST', 'project-repairs/fix-1/verify/extra'], ['GET', 'projects/../secrets'],
    ['GET', 'projects/desk/secrets'], ['GET', 'project-runs'],
  ])('denies %s %s', (method, path) => {
    expect(resolveProxyTarget(method, path.split('/'))).toBeNull();
  });
});
