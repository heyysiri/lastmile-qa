import { runtime } from '../../../lib/runtime';
export const dynamic = 'force-dynamic';
export const POST = (req: Request) => runtime().api.startSession(req);
