import { useCallback, useEffect, useRef, useState } from 'react';
import type { RunStatus } from '@lastmile/contracts';
import type { RepairJob } from '@lastmile/contracts/evolution';
import type { PopulationDetail, PopulationExecution } from '@lastmile/contracts/populations';
import { ApiFailure } from './api';

export const populationHref = (id: string) => `/populations/${encodeURIComponent(id)}`;
export const populationExecutionHref = (populationId: string, id: string) =>
  `${populationHref(populationId)}/executions/${encodeURIComponent(id)}`;
export const isActive = (status: RunStatus | RepairJob['status']) => status === 'queued' || status === 'running';

export function checkpointBaselines(population: PopulationDetail, executions: PopulationExecution[]) {
  const episodes = new Map(population.episodes.map(episode => [episode.run.id, episode]));
  return executions.filter(execution =>
    execution.populationId === population.id && execution.mode === 'continue' && execution.status === 'completed'
    && execution.members.length === population.testers.length
    && population.testers.every(tester => {
      const member = execution.members.find(item => item.testerId === tester.id);
      const episode = member && episodes.get(member.runId);
      if (episode?.executionId !== execution.id || episode?.testerId !== tester.id) return false;
      const { run } = episode;
      const { continuity, evidence } = run;
      const passingChecks = new Set(run.assertions.filter(result => result.status === 'passed').map(result => result.id));
      return run.status === 'completed' && run.verdict === 'passed' && run.executionMode === 'ai_guided'
        && continuity?.mode === 'continue' && continuity.populationId === population.id && continuity.testerId === tester.id
        && Boolean(continuity.startCheckpoint?.id && continuity.startCheckpoint.digest)
        && Boolean(evidence?.finishedByAgent && evidence.buildId === execution.buildId
          && evidence.scenarioHash && evidence.actions.length && !evidence.replayHash)
        && run.assertions.length === run.scenario.contract.assertions.length
        && run.scenario.contract.assertions.every(check => passingChecks.has(check.id));
    }));
}

/** Preserve the entire accepted-or-unknown payload, including its ID, across reloads. */
export function usePendingWrite<Request, Result extends { id: string }>(
  key: string,
  schema: { safeParse: (value: unknown) => { success: true; data: Request } | { success: false } },
  send: (request: Request) => Promise<Result>,
  onSuccess: (id: string, result: Result) => void,
  onRejected: (error: ApiFailure, request: Request) => void,
  resetOnSuccess = false,
) {
  const [ready, setReady] = useState(false);
  const [pending, setPending] = useState<Request | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const lock = useRef(false);

  useEffect(() => {
    try {
      const restored = schema.safeParse(JSON.parse(sessionStorage.getItem(key) ?? 'null'));
      if (restored.success) setPending(restored.data);
    } catch { /* Keep open-tab retries available when browser storage is unavailable. */ }
    setReady(true);
  }, [key, schema]);

  const clear = useCallback(() => {
    setPending(null);
    try { sessionStorage.removeItem(key); } catch { /* The request has been resolved. */ }
  }, [key]);

  const resolve = useCallback(() => {
    clear();
    setError(null);
    lock.current = false;
    setBusy(false);
  }, [clear]);

  async function submit(draft?: Request) {
    const request = pending ?? draft;
    if (!ready || lock.current || !request) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    setPending(request);
    try { sessionStorage.setItem(key, JSON.stringify(request)); } catch { /* Retain the pending request in memory. */ }
    try {
      const result = await send(request);
      if (!result?.id) throw new Error('The response was incomplete. Recover the original request to check its outcome.');
      onSuccess(result.id, result);
      if (resetOnSuccess) resolve();
      else clear();
    } catch (problem) {
      // A lost response or gateway failure can arrive after an accepted write.
      const rejected = problem instanceof ApiFailure && (
        (problem.status >= 400 && problem.status < 500 && problem.status !== 408)
        || (problem.status === 503 && ['context_unavailable', 'build_unavailable', 'execution_unavailable'].includes(problem.code))
      );
      if (rejected) {
        clear();
        onRejected(problem, request);
      }
      setError(problem);
      lock.current = false;
      setBusy(false);
    }
  }
  return { ready, pending, busy, error, resolve, submit };
}
