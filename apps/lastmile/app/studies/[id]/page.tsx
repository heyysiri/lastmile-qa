import { StudyReview } from '../../../components/StudyReview';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <StudyReview id={id} />;
}
