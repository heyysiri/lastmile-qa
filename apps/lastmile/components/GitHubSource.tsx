import { ArrowUpRight, GitBranch } from 'lucide-react';
import type { Project } from '@lastmile/contracts/projects';
import { githubRepoName, relativeTime, shortSha } from '../lib/projects';

/** Compact, human-readable source state for a GitHub-backed project. */
export function GitHubSource({ project, now }: { project: Project; now?: number }) {
  const github = project.github;
  if (!github) return null;
  const repository = github.repositoryUrl.replace(/\/+$/, '').replace(/\.git$/, '');
  const synced = github.syncedAt && github.sha;
  return <p className="project-source" aria-label="Source">
    <a className="project-app-link" href={repository} target="_blank" rel="noreferrer">{githubRepoName(github.repositoryUrl)}<ArrowUpRight size={14} aria-hidden="true" /></a>
    <span><GitBranch size={13} aria-hidden="true" /><code>{github.branch}</code>{github.sha && <code title="Latest synced commit">{shortSha(github.sha)}</code>}</span>
    {synced ? <span>Synced <time dateTime={github.syncedAt} title={new Date(github.syncedAt!).toLocaleString()}>{relativeTime(github.syncedAt!, now)}</time></span> : <span>Not synced yet</span>}
    {github.lastTestedSha
      ? <span data-current={github.lastTestedSha === github.sha ? 'true' : 'false'}>Tested <code>{shortSha(github.lastTestedSha)}</code></span>
      : <span>Not tested yet</span>}
  </p>;
}
