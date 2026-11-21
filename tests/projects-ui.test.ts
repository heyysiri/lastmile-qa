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

// Resolve React from the dashboard workspace, which owns the rendering dependency.
import { createRequire } from 'node:module';
import { desktopContext } from '../packages/contracts/src/examples';
import { TesterPersona, JourneyStages } from '../apps/lastmile/components/ProjectEvidence';
const dashboardRequire = createRequire(new URL('../apps/lastmile/package.json', import.meta.url));
const { createElement } = dashboardRequire('react');
const { renderToStaticMarkup } = dashboardRequire('react-dom/server');

it('renders real persona context and the selection rationale without exposing input data', () => {
  const html = renderToStaticMarkup(createElement(TesterPersona, { tester: {
    id: 'noa', name: 'Noa', role: 'Front desk', summary: 'Moves reservations.',
    selectionReason: 'Covers interrupted booking changes.',
    context: { ...desktopContext, preferredLanguage: 'French', familiarity: 'first_time', interaction: 'keyboard_only',
      background: 'Works the evening shift.', network: { mode: 'offline' }, inputs: { private: 'do-not-display' } },
  } }));
  for (const value of ['Covers interrupted booking changes.', 'French', 'First-time user', 'Keyboard only', 'Offline', 'Works the evening shift.']) expect(html).toContain(value);
  expect(html).toContain('<details');
  expect(html).not.toContain('do-not-display');
});

it('renders ordered stages and distinguishes recorded interruptions from planned behavior', () => {
  const html = renderToStaticMarkup(createElement(JourneyStages, {
    journey: { stages: [
      { id: 'edit', label: 'Edit booking', goal: 'Change the date.', transition: 'continue' },
      { id: 'return', label: 'Return to booking', goal: 'Check the saved date.', transition: 'reopen', pauseMs: 1500, network: { mode: 'offline' } },
    ] },
    network: { mode: 'normal' },
    evidence: [{ id: 'edit', actionStart: 0, actionEnd: 2, transition: 'continue', network: { mode: 'normal' }, pauseMs: 0, modelCalls: 1, completed: true }],
  }));
  expect(html).toContain('<ol');
  expect(html.indexOf('Edit booking')).toBeLessThan(html.indexOf('Return to booking'));
  for (const value of ['Leave and return', 'Offline', '1.5 s', 'short interruptions', 'Completed', 'Not recorded']) expect(html).toContain(value);
});

it('uses recorded network behavior and carries planned network changes into later stages', () => {
  const journey = { stages: [
    { id: 'start', label: 'Start', goal: 'Read.', transition: 'continue', network: { mode: 'offline' } },
    { id: 'return', label: 'Return', goal: 'Read again.', transition: 'reopen' },
  ] };
  const planned = renderToStaticMarkup(createElement(JourneyStages, { journey, network: { mode: 'normal' } }));
  expect(planned.match(/Offline/g)).toHaveLength(2);
  expect(planned).not.toContain('Normal connection');
  const actual = renderToStaticMarkup(createElement(JourneyStages, { journey, network: { mode: 'normal' }, evidence: [
    { id: 'start', actionStart: 0, actionEnd: 0, transition: 'continue', network: { mode: 'normal' }, pauseMs: 0, modelCalls: 0, completed: false },
  ] }));
  expect(actual).toContain('Normal connection');
  expect(actual).toContain('Incomplete');
  expect(actual).toContain('Planned:');
});

it('keeps legacy journeys without stages free of invented stage evidence', () => {
  expect(renderToStaticMarkup(createElement(JourneyStages, { journey: {}, network: { mode: 'normal' } }))).toBe('');
});
