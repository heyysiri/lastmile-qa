import { runtime } from '../../../../lib/runtime';
export const dynamic = 'force-dynamic';
export const GET = (req: Request) => runtime().api.testState(req);
