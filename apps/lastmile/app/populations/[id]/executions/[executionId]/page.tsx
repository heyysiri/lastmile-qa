import { PopulationResults } from '../../../../../components/PopulationResults';

export default async function Page({ params }: { params: Promise<{ id: string; executionId: string }> }) {
  const { id, executionId } = await params;
  return <PopulationResults key={executionId} populationId={id} executionId={executionId} />;
}
