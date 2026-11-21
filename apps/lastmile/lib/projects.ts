import { z } from 'zod';
import type { ProjectRun } from '@lastmile/contracts/projects';
import { ApiFailure } from './api';

export const projectHref = (id: string) => `/projects/${encodeURIComponent(id)}`;
export const projectRunHref = (id: string, runId: string) => `${projectHref(id)}/runs/${encodeURIComponent(runId)}`;
export const projectRepairHref = (id: string) => `/project-repairs/${encodeURIComponent(id)}`;
export const projectRequestId = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
export const projectRefreshRequest = z.object({ requestId: projectRequestId });
export const canPrepareProjectRepair = (run: ProjectRun) => run.status === 'completed'
  && run.results.some(result => result.run.verdict === 'failed')
  && run.findings.some(finding => finding.confidence === 'confirmed' && finding.failedCheckIds.length > 0);

// A gateway or transport failure can arrive after the write was accepted.
export const connectWasRejected = (error: unknown) => error instanceof ApiFailure
  && error.status >= 400 && error.status < 500 && ![408, 409].includes(error.status);
