import { runtime } from '../../../../../../lib/runtime';

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return runtime().api.testCheckpointClone(req, id);
}
