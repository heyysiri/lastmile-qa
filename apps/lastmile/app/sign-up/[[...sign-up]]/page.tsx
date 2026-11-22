import { SignUp } from '@clerk/nextjs';
import { redirect } from 'next/navigation';
import { dashboardAuthMode } from '../../../lib/dashboard-auth';

export default function SignUpPage() {
  if (dashboardAuthMode() !== 'clerk') redirect('/');
  return <main className="auth-page">
    <div className="auth-intro"><span className="auth-wordmark">lastmile qa.</span><h1>Meet your next<br />test team.</h1><p>Create your account. Your projects and connected credentials belong to your private workspace.</p></div>
    <SignUp routing="path" path="/sign-up" signInUrl="/sign-in" />
  </main>;
}
