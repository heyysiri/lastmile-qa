import { describe, expect, it } from 'vitest';
import { resolveProxyTarget } from '../apps/lastmile/lib/proxy-policy';

describe('dashboard evolution proxy policy', () => {
  it.each([
    ['GET', 'populations/shops/suggestions'],
    ['POST', 'populations/shops/suggestions'],
    ['GET', 'suggestions/job-1'],
    ['GET', 'repairs'],
    ['GET', 'repairs/job-1'],
    ['POST', 'repairs'],
    ['POST', 'repairs/job-1/verify'],
  ])('allows %s %s', (method, path) => {
    expect(resolveProxyTarget(method, path.split('/'))).toBe(`/api/${path}`);
  });

  it.each([
    ['PUT', 'repairs/job-1'], ['DELETE', 'repairs/job-1'],
    ['GET', 'repairs/job-1/verify'], ['POST', 'repairs/job-1/apply'],
    ['POST', 'repairs/job-1/verify/extra'], ['POST', 'repairs/../verify'],
    ['POST', 'suggestions/job-1'], ['GET', 'suggestions'],
    ['GET', 'populations/shops/suggestions/job-1'], ['PUT', 'populations/shops/suggestions'],
  ])('denies %s %s', (method, path) => {
    expect(resolveProxyTarget(method, path.split('/'))).toBeNull();
  });
});
