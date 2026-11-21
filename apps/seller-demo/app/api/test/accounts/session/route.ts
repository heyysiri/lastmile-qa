import { runtime } from '../../../../../lib/runtime';

export const POST = (req: Request) => runtime().api.testAccountSession(req);
