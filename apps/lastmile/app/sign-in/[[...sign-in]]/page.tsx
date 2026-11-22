import { SignIn } from '@clerk/nextjs';
import { redirect } from 'next/navigation';
import { dashboardAuthMode } from '../../../lib/dashboard-auth';

export default function SignInPage() {
  if (dashboardAuthMode() !== 'clerk') redirect('/');
  return <main className="auth-page">
    <div className="auth-intro"><span className="auth-wordmark">lastmile qa.</span><h1>Your users.<br />Your next release.</h1><p>Sign in to your private workspace. Keep your test team, findings and fixes together.</p></div>
    <SignIn routing="path" path="/sign-in" signUpUrl="/sign-up" />
  </main>;
}
