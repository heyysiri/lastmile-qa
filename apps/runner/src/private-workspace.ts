import { join } from 'node:path';
import { createServer } from './server';
import { createGitHubCredentials } from './github-credentials';
import { createProjectRuntime } from './project-runtime';
import { createProjectRepository } from './project-repository';

export function createPrivateWorkspace(options: { directory: string; apiToken: string; apiKey?: string; model?: string }) {
  const artifactRoot = join(options.directory, 'artifacts');
  // No operator/environment PAT fallback: each user explicitly connects GitHub.
  const credentials = createGitHubCredentials({ directory: join(options.directory, 'credentials') });
  const runtime = options.apiKey ? createProjectRuntime({
    privateRoot: join(options.directory, 'projects'), artifactRoot,
    apiKey: options.apiKey, model: options.model ?? 'gpt-4.1-mini',
  }) : undefined;
  if (runtime) runtime.repository = createProjectRepository({ root: join(options.directory, 'repositories'), token: credentials.token });
  const app = createServer({
    databasePath: join(options.directory, 'qa.sqlite'), artifactRoot, apiToken: options.apiToken,
    githubCredentials: credentials, projectRuntime: runtime, modelConfigured: Boolean(options.apiKey),
    startOnReady: true, projectsOnly: true,
  });
  app.addHook('onClose', async () => { await runtime?.repository?.close?.(); });
  return app;
}
