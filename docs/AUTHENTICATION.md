# Sign-in and private workspaces

Lastmile uses Clerk for dashboard accounts. This is separate from connecting Claude Code, Codex or GitHub.

## Local setup

Add keys from the same Clerk application to the root `.env` (never commit it):

```dotenv
LASTMILE_AUTH=clerk
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_...
CLERK_SECRET_KEY=sk_test_...
RUNNER_API_TOKEN=<random server-only secret of at least 32 characters>
```

Build the dashboard after changing the publishable key, then restart dashboard and runner. The dashboard loads the root `.env`, including when started directly with its package command. Enable desired login methods in Clerk; the built-in sign-in/sign-up screens follow those settings.

Open http://127.0.0.1:3000. Signed-out visitors see sign-in. After signing in, the account menu appears at the top right and the workspace starts empty. Connect GitHub with your own PAT. No operator PAT is inherited.

Projects, histories, artifacts, cloned repositories, browser sessions and encrypted GitHub credentials use a separate `.data/workspaces/<hashed Clerk user ID>/` directory. The trusted dashboard proxy sends only the user ID verified by Clerk; the private runner requires its server credential before accepting that identity. It listens on loopback only. User IDs supplied by the browser cannot select another workspace.

Existing shared local data is left untouched; it is not assigned to whichever user signs in first. Pending browser requests clear when the account changes. The runner opens at most 16 workspaces per process to bound resources; existing workspaces remain available at capacity. Workspace databases persist across restart and reopen when their user next accesses them.

## Check it

1. While signed out, opening `/` redirects to sign-in; `/api/runner/projects` returns 401.
2. Create/sign in to account A. Its project list starts empty and GitHub access is unconfigured.
3. Save account A's GitHub PAT. Sign out using the account menu.
4. Sign into account B in another browser profile. It has its own empty project list and no saved PAT. Opening A's project URL returns not found.
5. Sign into A again. A's own projects and GitHub configuration remain available.

## Deployment boundaries

Set `DASHBOARD_ORIGIN` to the exact HTTPS origin, use Clerk production keys for that domain, and keep the runner inaccessible from the public network. Missing auth configuration fails closed.

This change provides authentication and API/storage isolation. The existing repository build/test engine executes code on its host, so it is not an operating-system sandbox between untrusted users. Accordingly, the private hosted runtime (`DASHBOARD_ORIGIN` set) does not start repository execution until isolated workers are integrated. Local authenticated testing retains the existing trusted-local execution path. Arbitrary server-folder connections and legacy shared demos are unavailable in private workspaces.

AWS deployment is still paused. Official per-user Claude Code connection and hosted execution isolation remain separate requirements; Clerk sign-in does not grant Claude Code access.

## Verification performed

32 scoped automated checks passed, including separate SQLite stores and encrypted PAT storage, cross-user 404s, bearer/header spoofing, queue recovery, and account-switch pending-request cleanup. The production dashboard build, both TypeScript checks and scoped lint passed. Live browser verification used two disposable Clerk development accounts and real signed sessions: redirect to sign-in, authenticated workspace access, no inherited operator PAT, and signing out through the account menu revoked API access. Test accounts were deleted afterward. Normal email verification/Google consent remain user-operated checks.
