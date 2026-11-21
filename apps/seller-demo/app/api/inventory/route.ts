import { runtime } from '../../../lib/runtime';
export const dynamic = 'force-dynamic';
export const GET = (req: Request) => runtime().api.getInventory(req);
export const PUT = (req: Request) => runtime().api.putInventory(req);
