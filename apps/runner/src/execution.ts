import type { RunRecord } from '@lastmile/contracts';

export type ExecuteRun = (run: RunRecord, onUpdate: (run: RunRecord) => void) => Promise<RunRecord>;

export const executeRun: ExecuteRun = async (run) => ({
  ...run,
  status: 'completed',
  verdict: 'inconclusive',
  findings: [{
    kind: 'environment_failure',
    description: 'Browser execution is not configured yet',
    evidencePaths: [],
  }],
});
