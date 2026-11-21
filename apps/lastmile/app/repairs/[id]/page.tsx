import { RepairReview } from '../../../components/RepairReview';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <RepairReview key={id} id={id} />;
}
