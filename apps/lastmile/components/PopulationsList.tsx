'use client';

import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { api, useLoad } from '../lib/api';
import { populationHref } from '../lib/populations';
import { plural, StudioError, TesterFace } from './Studio';
import { Pending } from './ui';

export function PopulationsList() {
  const populations = useLoad(api.populations);
  return <div className="studio">
    <header className="studio-heading"><h1>Populations</h1><p>Follow returning testers and check what changes from one release to the next.</p></header>
    <StudioError error={populations.error} onRetry={populations.reload} />
    {populations.loading && !populations.data && <Pending label="Loading populations…" />}
    {populations.data?.length === 0 && <section className="studio-card tester-intro population-empty">
      <div className="face-scene">{[0, 1, 2].map(index => <TesterFace key={index} index={index} />)}</div>
      <div><h2>Give your testers a place to come back to</h2>
        <p>Save a study, then enroll its testers to give them reusable accounts and a history of what they saw.</p>
        <Link href="/studies" className="evidence-link">Create a study <ArrowRight size={16} aria-hidden="true" /></Link>
      </div>
    </section>}
    <div className="result-grid">
      {populations.data?.map(population => <Link key={population.id} href={populationHref(population.id)} className="studio-card population-tile">
        <div className="population-faces">{population.testers.map((tester, index) => <TesterFace index={index} key={tester.id} />)}</div>
        <h2>{population.label}</h2>
        <p>{plural(population.testers.length, 'tester')} · Study revision {population.studyRevision}</p>
        <span className="evidence-link">Open population <ArrowRight size={16} aria-hidden="true" /></span>
      </Link>)}
    </div>
    {Boolean(populations.data?.length) && <p className="history-footer"><Link href="/studies">Create or review a study</Link></p>}
  </div>;
}
