import { ClerkProvider } from '@clerk/nextjs';
import { dashboardAuthMode } from '../lib/dashboard-auth';
import { AuthenticatedShell } from '../components/AuthenticatedShell';
import type { Metadata } from 'next';
import '@fontsource-variable/manrope';
import './globals.css';
import './studio.css';
import './projects.css';
import { Shell } from '../components/Shell';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'lastmile qa.', description: 'Study how synthetic testers experience your connected application' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const clerk = dashboardAuthMode() === 'clerk';
  return (
    <html lang="en">
      <body>{clerk ? <ClerkProvider signInUrl="/sign-in" signUpUrl="/sign-up" signInFallbackRedirectUrl="/" signUpFallbackRedirectUrl="/" afterSignOutUrl="/sign-in">
        <AuthenticatedShell>{children}</AuthenticatedShell>
      </ClerkProvider> : <Shell>{children}</Shell>}</body>
    </html>
  );
}
