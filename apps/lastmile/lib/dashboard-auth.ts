/** Public deployments fail closed; keyless local development stays available. */
export function dashboardAuthMode(env: Record<string, string | undefined> = process.env): 'local' | 'clerk' | 'unconfigured' {
  if (env.LASTMILE_AUTH === 'clerk' || env.CLERK_SECRET_KEY || env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) {
    return env.CLERK_SECRET_KEY?.trim() && env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY?.trim() ? 'clerk' : 'unconfigured';
  }
  return env.DASHBOARD_ORIGIN || (env.LASTMILE_AUTH && env.LASTMILE_AUTH !== 'local') ? 'unconfigured' : 'local';
}
