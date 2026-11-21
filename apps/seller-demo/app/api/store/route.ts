import { runtime } from '../../../lib/runtime';
export const dynamic = 'force-dynamic';
export const GET = (req: Request) => runtime().api.getStore(req);
export const PUT = (req: Request) => runtime().api.putStore(req);
