import type { ConnectGitHubProjectRequest, ConnectProjectRequest, SyncGitHubProjectRequest, Project, ProjectDetail, ProjectRepair, ProjectRepairRequest, ProjectRun, ProjectRunRequest } from '@lastmile/contracts/projects';
import type { EvidenceRun, InvestigationRecord, InvestigationRequest } from '@lastmile/contracts/runtime';
import type { PrepareRepairRequest, RepairJob, SuggestionJob, SuggestJourneysRequest, VerifyRepairRequest } from '@lastmile/contracts/evolution';
import type { ApplicationContext, EnrollPopulationRequest, LaunchPopulationRequest, Population, PopulationDetail, PopulationExecution, PopulationExecutionDetail } from '@lastmile/contracts/populations';
import type { GenerateStudyRequestSchema, LaunchStudyRequestSchema, SaveStudyRequestSchema, Study, StudyApplication, StudyExecution, StudyExecutionDetail } from '@lastmile/contracts/studies';
import type { infer as Infer } from 'zod';
import type { ContextPack, ScenarioDefinition } from '@lastmile/contracts';

export type Health = { status: 'ok'; modelConfigured: boolean; executionReady: boolean; suggestionsReady?: boolean; repairsReady?: boolean; projectDiscoveryReady?: boolean; projectExecutionReady?: boolean; projectRepairsReady?: boolean };
export type CapabilityInfo = { factor: string; mode?: string; description?: string; [k: string]: unknown };
export class ApiFailure extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/runner/${path}`, {
      method, cache: 'no-store',
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiFailure(0, 'dashboard_offline', 'Could not reach the dashboard server.');
  }
  const text = await res.text();
  let json: unknown;
  try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
  if (!res.ok) {
    const e = (json ?? {}) as { code?: string; message?: string };
    throw new ApiFailure(res.status, e.code ?? 'http_error', e.message ?? `Request failed with status ${res.status}`);
  }
  return json as T;
}

export const api = {
  projects: () => call<Project[]>('GET', 'projects'),
  project: (id: string) => call<ProjectDetail>('GET', `projects/${encodeURIComponent(id)}`),
  projectByRequest: (id: string) => call<Project>('GET', `projects/by-request/${encodeURIComponent(id)}`),
  connectProject: (request: ConnectProjectRequest) => call<Project>('POST', 'projects', request),
  connectGitHubProject: (request: ConnectGitHubProjectRequest) => call<Project>('POST', 'projects/github', request),
  syncProject: (id: string, request: SyncGitHubProjectRequest) => call<Project>('POST', `projects/${encodeURIComponent(id)}/sync`, request),
  refreshProject: (id: string, request: { requestId: string }) => call<Project>('POST', `projects/${encodeURIComponent(id)}/refresh`, request),
  runProject: (id: string, request: ProjectRunRequest) => call<ProjectRun>('POST', `projects/${encodeURIComponent(id)}/runs`, request),
  projectRun: (id: string) => call<ProjectRun>('GET', `project-runs/${encodeURIComponent(id)}`),
  projectRepairs: (projectId: string) => call<ProjectRepair[]>('GET', `project-repairs?projectId=${encodeURIComponent(projectId)}`),
  projectRepair: (id: string) => call<ProjectRepair>('GET', `project-repairs/${encodeURIComponent(id)}`),
  prepareProjectRepair: (request: ProjectRepairRequest) => call<ProjectRepair>('POST', 'project-repairs', request),
  verifyProjectRepair: (id: string, request: VerifyRepairRequest) => call<ProjectRepair>('POST', `project-repairs/${encodeURIComponent(id)}/verify`, request),
  publishProjectRepair: (id: string, request: { requestId: string }) => call<ProjectRepair>('POST', `project-repairs/${encodeURIComponent(id)}/publish`, request),
  applications: () => call<StudyApplication[]>('GET', 'applications'),
  applicationContext: (id: string) => call<ApplicationContext>('GET', `applications/${encodeURIComponent(id)}/context`),
  populations: () => call<Population[]>('GET', 'populations'),
  population: (id: string) => call<PopulationDetail>('GET', `populations/${encodeURIComponent(id)}`),
  enrollPopulation: (request: EnrollPopulationRequest) => call<Population>('POST', 'populations', request),
  launchPopulation: (id: string, request: LaunchPopulationRequest) => call<PopulationExecution>('POST', `populations/${encodeURIComponent(id)}/executions`, request),
  populationExecutions: () => call<PopulationExecution[]>('GET', 'population-executions'),
  populationExecution: (id: string) => call<PopulationExecutionDetail>('GET', `population-executions/${encodeURIComponent(id)}`),
  suggestions: (populationId: string) => call<SuggestionJob[]>('GET', `populations/${encodeURIComponent(populationId)}/suggestions`),
  suggestion: (id: string) => call<SuggestionJob>('GET', `suggestions/${encodeURIComponent(id)}`),
  suggestJourneys: (populationId: string, request: SuggestJourneysRequest) => call<SuggestionJob>('POST', `populations/${encodeURIComponent(populationId)}/suggestions`, request),
  repairs: (populationId: string) => call<RepairJob[]>('GET', `repairs?populationId=${encodeURIComponent(populationId)}`),
  repair: (id: string) => call<RepairJob>('GET', `repairs/${encodeURIComponent(id)}`),
  prepareRepair: (request: PrepareRepairRequest) => call<RepairJob>('POST', 'repairs', request),
  verifyRepair: (id: string, request: VerifyRepairRequest) => call<RepairJob>('POST', `repairs/${encodeURIComponent(id)}/verify`, request),
  studies: () => call<Study[]>('GET', 'studies'),
  study: (id: string) => call<Study>('GET', `studies/${encodeURIComponent(id)}`),
  generateStudy: (request: Infer<typeof GenerateStudyRequestSchema>) => call<Study>('POST', 'studies/generate', request),
  saveStudy: (id: string, request: Infer<typeof SaveStudyRequestSchema>) => call<Study>('PUT', `studies/${encodeURIComponent(id)}`, request),
  launchStudy: (id: string, request: Infer<typeof LaunchStudyRequestSchema>) => call<StudyExecution>('POST', `studies/${encodeURIComponent(id)}/launch`, request),
  executions: () => call<StudyExecution[]>('GET', 'study-executions'),
  execution: (id: string) => call<StudyExecutionDetail>('GET', `study-executions/${encodeURIComponent(id)}`),
  replay:(id:string,request:{requestId:string;contextPackId:string;contextRevision:number})=>call<{id:string;status:string}>('POST',`runs/${encodeURIComponent(id)}/replay`,request),
  investigations:()=>call<InvestigationRecord[]>('GET','investigations'),
  investigate:(request:InvestigationRequest)=>call<InvestigationRecord>('POST','investigations',request),
  health: () => call<Health>('GET', 'health'),
  capabilities: () => call<CapabilityInfo[]>('GET', 'capabilities'),
  scenarios: () => call<ScenarioDefinition[]>('GET', 'scenarios'),
  contexts: () => call<ContextPack[]>('GET', 'context-packs'),
  createScenario: (s: ScenarioDefinition) => call<ScenarioDefinition>('POST', 'scenarios', s),
  updateScenario: (s: ScenarioDefinition) => call<ScenarioDefinition>('PUT', `scenarios/${encodeURIComponent(s.id)}`, s),
  createContext: (c: ContextPack) => call<ContextPack>('POST', 'context-packs', c),
  updateContext: (c: ContextPack) => call<ContextPack>('PUT', `context-packs/${encodeURIComponent(c.id)}`, c),
  runs: () => call<EvidenceRun[]>('GET', 'runs'),
  run: (id: string) => call<EvidenceRun>('GET', `runs/${encodeURIComponent(id)}`),
  artifacts: (id: string) => call<unknown[]>('GET', `runs/${encodeURIComponent(id)}/artifacts`),
};

/** Small load helper with explicit loading/error state. */
import { useCallback, useEffect, useState } from 'react';
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiFailure | null>(null);
  const [loading, setLoading] = useState(true);
  const reload = useCallback(async () => {
    setLoading(true);
    try { setData(await fn()); setError(null); } catch (e) { setError(e instanceof ApiFailure ? e : new ApiFailure(0, 'unknown', String(e))); } finally { setLoading(false); }
  }, deps);
  useEffect(() => { void reload(); }, [reload]);
  return { data, error, loading, reload, setData };
}
