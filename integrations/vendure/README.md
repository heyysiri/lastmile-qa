# Vendure v3.5.0 development recipe

The tested base is `534e6003534f74761e82de1b8c6061cba89945d1` from
[heyysiri/vendure](https://github.com/heyysiri/vendure). The managed GitHub environment
clones the fork and selects its revision or branch before provisioning. Descendant
commits are supported: preparation never resets HEAD, changes branches, or rewrites remotes.

## Managed checkout

```js
import { prepareVendureRecipe, VENDURE_REVISION } from './integrations/vendure/recipe.mjs';
const recipe = prepareVendureRecipe({ workspace: '/absolute/path/to/vendure', port: 9321 });
```

`prepareVendureRecipe` is synchronous, performs no network calls, and runs no package
installation, build, seed, or server. It copies the validated `app/` templates into
`local-marketplace`, preserves existing files, and generates credentials once.
It returns JSON-serializable public metadata:

- `workingDirectory`: absolute `local-marketplace` directory; run every command here.
- `installCommand`: pinned Node 22.22.0 npm installation plus native dependency rebuild.
- `buildCommand`: upstream package and dashboard build followed by idempotent seed.
- `startCommand`: pinned Node 22.22.0 start with `PORT=<chosen port>`.
- `port`: supplied integer, omitted when the caller has not allocated one yet.
- `databasePath`: absolute SQLite path.
- `runtimeFiles`: absolute credential-file, SQLite, and asset-directory paths; no secret values.

If `port` is omitted, `startCommand` contains `{port}`; replace it with the allocated
integer before execution. The server binds only `127.0.0.1`. It requires `PORT` and
has no fixed default listener. The seed uses an ephemeral port independently.
The dashboard and APIs share the chosen origin at `/dashboard/`, `/admin-api`, and
`/shop-api`. Build produces static dashboard assets; no Vite development listener is needed.

Equivalent CLI (stdout is one JSON object in preparation mode):

```sh
node scripts/setup-vendure.mjs --workspace /absolute/path/to/vendure --port 9321 --prepare-only
```

Without `--prepare-only`, the CLI installs, builds and seeds, then prints the recipe.
For standalone use only, a missing workspace is fetched from the fork at the pinned
commit. `VENDURE_WORKSPACE` or the default `.local-work/p3/vendure-app` selects that
location. Preparation mode requires an existing clone and never fetches.

## Persistent runtime state

The entire `local-marketplace/` directory is excluded through Git's local
`info/exclude`, including credentials, SQLite, uploaded assets, temporary compiler
output, and build output. Preparation rejects tracked runtime files. Never force-add
this directory. Fixes belong in upstream source under `packages/core/src` or
`packages/dashboard/src`; runtime configuration is supplied by this integration.

Credentials are generated with mode 0600 at `local-marketplace/.data/credentials.json`:
`cookieSecret`, `manager`, `catalog`, and `orders` are independent random strings.
Native login accounts are `manager@example.test` (SuperAdmin),
`catalog@example.test` (catalogue/inventory), and `orders@example.test` (orders).
Their password is the correspondingly named JSON field. Only the trusted runtime
should read this file into its private secret store. Public reports retain paths only.

The existing fixture imports the upstream sample catalogue, stock, native draft
orders, and a simulated paid order. The recipe contains no test journeys or generated
persona policy. After merging a source fix, sync the same checkout, rerun
`buildCommand`, and restart with the allocated port. Keep `.data` intact: seed skips
an existing SQLite database, so the same staff credentials, records and user edits
remain. A database without its original credential file is rejected. Preparation
also preserves local template customizations; upgrading templates is explicit.

No optional demo defect is applied by this recipe. A demonstrator may separately
commit an intentional source defect to a dedicated fork branch, clearly label it,
and exercise the ordinary fix/verify/PR/manual-merge flow.
