import { StudyResults } from '../../../../../components/StudyResults';

export default async function Page({ params }: { params: Promise<{ id: string; executionId: string }> }) {
  const { id, executionId } = await params;
  return <StudyResults studyId={id} executionId={executionId} />;
}
