import { clerkMiddleware } from '@clerk/nextjs/server';
import { NextResponse, type NextRequest, type NextFetchEvent } from 'next/server';
import { dashboardAuthMode } from './lib/dashboard-auth';

const clerk = clerkMiddleware(async (auth, request) => {
  const path = request.nextUrl.pathname;
  // API handlers enforce auth independently and return JSON rather than redirects.
  if (!path.startsWith('/api/') && !/^\/(sign-in|sign-up)(\/|$)/.test(path)) await auth.protect();
}, { signInUrl: '/sign-in', signUpUrl: '/sign-up' });

export default function proxy(request: NextRequest, event: NextFetchEvent) {
  const mode = dashboardAuthMode();
  if (mode === 'local') return NextResponse.next();
  if (mode === 'unconfigured') return NextResponse.json({ code: 'auth_unconfigured', message: 'Sign-in is not configured. Contact the workspace administrator.' }, { status: 503 });
  return clerk(request, event);
}

export const config = { matcher: ['/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|webmanifest)).*)', '/api/(.*)'] };
