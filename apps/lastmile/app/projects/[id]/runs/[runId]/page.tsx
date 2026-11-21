import { ProjectRunPage } from '../../../../../components/ProjectHome';

export default async function Page({ params }: { params: Promise<{ id: string; runId: string }> }) {
  const { id, runId } = await params;
  return <ProjectRunPage key={runId} projectId={id} runId={runId} />;
}
