'use client';

import { ArrowUpRight, FolderGit2 } from 'lucide-react';
import Link from 'next/link';
import { api, useLoad } from '../lib/api';
import { githubRepoName, projectHref } from '../lib/projects';
import { ConnectProject } from './ProjectConnect';
import { StudioError, TesterFace } from './Studio';
import { Pending } from './ui';

export function ProjectsList() {
  const projects = useLoad(api.projects);
  const health = useLoad(api.health);
  const ready = health.data?.projectDiscoveryReady === true && !health.error;


  return <div className="studio project-studio">
    <header className="directory-hero">
      <div><span className="workspace-eyebrow">Persistent AI users for your app</span>
        <h1>New release.<br />Same users.</h1>
        <p>Your AI users return, pick up where they left off, and test what changed. Find the failure. Verify the fix.</p>
      </div>
      <div className="directory-illustration" aria-hidden="true">
        <span className="orbit-label label-one">Different people.</span>
        <div className="hero-faces"><TesterFace index={0} /><TesterFace index={1} /><TesterFace index={2} /></div>
        <span className="orbit-label label-two">Unexpected discoveries.</span>
      </div>
    </header>
    <StudioError error={health.error} onRetry={health.reload} />
    <section className="project-directory" aria-labelledby="connected-projects">
      <div className="directory-heading"><h2 id="connected-projects">Your projects <span>{projects.data?.length ?? '–'}</span></h2>
        <ConnectProject ready={ready} checkingHealth={health.loading} />
      </div>
      <StudioError error={projects.error} onRetry={projects.reload} />
      {projects.loading && !projects.data && <Pending label="Loading projects…" />}
      {projects.data?.length === 0 && <div className="directory-empty">
        <FolderGit2 size={30} aria-hidden="true" /><h3>Meet your first test team</h3>
        <p>Connect a GitHub repository to get started.</p>
      </div>}
      <ul className="project-grid">{projects.data?.map((project, index) => <li key={project.id}>
        <Link href={projectHref(project.id)} className="project-tile">
          <div className="project-tile-top"><span className={`project-monogram tone-${index % 3}`} aria-hidden="true">{project.name.slice(0, 1).toUpperCase()}</span>
            <span className="project-list-status" data-status={project.status}><i />{project.status === 'discovering' ? 'Getting to know your app' : project.status === 'failed' ? 'Needs attention' : 'Ready to test'}</span>
          </div>
          <h3>{project.name}</h3><p>{project.github ? `${githubRepoName(project.github.repositoryUrl)} · ${project.github.branch}` : project.appUrl}</p>
          <div className="project-tile-footer"><span>Open workspace</span><ArrowUpRight size={19} aria-hidden="true" /></div>
        </Link>
      </li>)}</ul>
    </section>
  </div>;
}
