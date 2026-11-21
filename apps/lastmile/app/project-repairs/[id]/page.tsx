import { ProjectRepairReview } from '../../../components/ProjectRepairReview';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ProjectRepairReview key={id} id={id} />;
}
