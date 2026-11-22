import { createDashboardProxy } from '../../../../lib/dashboard-proxy';
import { readClerkUserId } from '../../../../lib/clerk-session';

export const dynamic = 'force-dynamic';
const handle = createDashboardProxy(readClerkUserId);
export { handle as GET, handle as POST, handle as PUT };
