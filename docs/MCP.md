# Use lastmile qa. from Claude Code or Codex

The local MCP server gives your coding agent the same repository discovery, generated test team, explore/release runs, and private repair verification as the dashboard. It uses the official TypeScript MCP SDK over stdio and calls the existing authenticated runner. The runner owns jobs and keeps working if an MCP host disconnects.

## Start the application and runner

Install this repository with Node 22+ and `pnpm install --frozen-lockfile`. Configure the runner's model credentials in the repository's ignored `.env` as described in the main README, then start the existing stack with `pnpm dev` (or `pnpm start` after building). Start the development application you want to test separately.

Connecting requires an existing repository directory and a running HTTP application reachable from the runner. Browser runs can change the development application's business records. Use disposable development data and synthetic accounts. Connection credentials go to the runner's private account store and are excluded from its public project responses, but credentials entered as MCP arguments can remain in the host's conversation history.

The MCP process loads `.env` beside this repository's `package.json`, regardless of the host's working directory. Existing environment variables take precedence. It needs the runner API token, not a separate model key. Defaults match the local development stack:

| Variable | Default | Purpose |
| --- | --- | --- |
| `RUNNER_URL` | `http://127.0.0.1:4000` | Runner HTTP origin; no path, query, or credentials |
| `RUNNER_API_TOKEN` | `local-development-runner` | Must match the runner's token |
| `LASTMILE_DASHBOARD_URL` | `http://127.0.0.1:3000` | Origin used for dashboard links |
| `LASTMILE_MCP_TIMEOUT_MS` | `10000` | HTTP request timeout, 1-120000 ms; job execution continues independently |

## Register the MCP server

Replace `/ABS/PATH/Builders_EqualAI` with the absolute path to your installed checkout. The launcher works from any directory. These commands are for you to run; setup does not change your agent configuration automatically.

Claude Code:

```sh
claude mcp add --transport stdio lastmile-qa -- node /ABS/PATH/Builders_EqualAI/scripts/mcp.mjs
```

Codex:

```sh
codex mcp add lastmile-qa -- node /ABS/PATH/Builders_EqualAI/scripts/mcp.mjs
```

For hosts using JSON MCP configuration, the equivalent entry is:

```json
{
  "mcpServers": {
    "lastmile-qa": {
      "command": "node",
      "args": ["/ABS/PATH/Builders_EqualAI/scripts/mcp.mjs"]
    }
  }
}
```

Open a new host session after registration if the tool list has not refreshed. Ask it to call `lastmile_health` first. The launcher reserves stdout for MCP messages; its startup diagnostics go to stderr. `pnpm mcp` also starts the server for local inspection, but a host should launch the absolute Node script directly.

## Agent workflow

1. Call `lastmile_health`, then `lastmile_list_projects`. Health reports discovery, execution, and repair readiness; authenticated project access also verifies the token.
2. Reuse a project, or call `lastmile_connect_project` with a unique stable `requestId`, `name`, absolute `repositoryPath`, running `appUrl`, and a useful `brief`. Optional `requirements`, `allowedOrigins`, `accounts`, and fixed `commands` use the same schema as the dashboard. Accounts default to `[]`, requirements to `""`, and allowed origins to `[]`. For private repair, `commands.start` is an executable/argument array such as `["npm", "run", "dev", "--", "--port", "{port}"]`; use the application's actual command and supported port placeholder. Supply any required `build`, repository-relative `cwd`, `databasePath`, or `runtimeFiles` using the existing project's repair setup.
3. Poll `lastmile_get_project({projectId})` every few seconds until `ready` or `failed`. Inspect the generated testers, journey checks, sources, and gaps. If the connection response was lost, `lastmile_get_connection({requestId})` recovers it without creating another project.
4. Call `lastmile_run_project({projectId, requestId, mode: "explore"})`. `mode` defaults to `explore`; `autoRepair` defaults to `true`. Use `release` to retain prior coverage while checking a changed release. Set `autoRepair: false` when you want testing alone.
5. Poll `lastmile_get_run({runId})` until testing and any automatic repair reach terminal states. Its `run` includes findings, checks, and metrics; `repairs` contains compact status and verification summaries. Browser step logs are omitted by default. Use `includeEvidence: true` to retrieve the full frozen evidence.
6. Fetch a repair with `lastmile_get_repair({repairId})` to inspect its patch, verification checks, and execution/model-call summary. `includeEvidence: true` includes full source and replay logs. A verified patch is a private proposal; these tools do not apply it to your repository.

Reuse exactly the same inputs and `requestId` after a network timeout or lost write response. Use a fresh ID only for deliberately new work. IDs accept 1-80 letters, digits, underscores, or hyphens. A conflict means that ID already represents different inputs. If a run response is lost, repeating `lastmile_run_project` with the original arguments retrieves the existing job.

`lastmile_retry_repair({runId, requestId})` deliberately queues another automatic preparation-and-verification attempt. It requires a completed run with frozen failing evidence, a passing control, configured project commands, and an idle project. Poll the returned repair ID. Retry a lost response with the same request ID; use a fresh request ID for a new attempt.

## Understand completion

| `repairStatus` from `lastmile_get_run` | Meaning |
| --- | --- |
| `awaiting_run` | Testing is still queued/running; poll |
| `pending` | No automatic repair is visible yet; poll again and inspect errors if it persists |
| `queued`, `running` | A repair is active; keep polling |
| `completed` | Repair work ended; inspect `verification.outcome` |
| `interrupted` | Repair ended without completion; inspect its error |
| `awaiting_review` | Repair needs attention; inspect it rather than reporting success |
| `blocked` | Testing was interrupted/errored or automatic repair lacks requirements; read `run.error` and `run.repairBlockedReason` |
| `not_needed` | Testing finished with no failed or inconclusive checks |
| `not_requested` | This run did not request automatic repair |

A completed test run is not a verified repair. A completed repair can be `verified`, `rejected`, or `inconclusive`. Report these outcomes literally, including missing controls, inconclusive evidence, and blocked setup.

Example prompt for an existing project:

> Use lastmile-qa to check readiness and list projects. Find my connected app, inspect its generated test team, and run an explore pass with a stable request ID and automatic repair. Poll until both testing and repair finish. Report each finding and check, any blocked repair reason, and the patch's verification outcome. Do not apply the patch.

Example prompt for a new app:

> Connect `/absolute/path/to/my-app`, already running at `http://127.0.0.1:5173`, as “Inventory app”. The brief is “Test two staff roles editing stock, saving, and reloading without losing unrelated fields.” Use a stable connection request ID and the fixed development commands from this repository. Wait for discovery, explain the generated team and gaps, then run and follow automatic private repair to its final verification outcome.

## Troubleshooting and scope

- `runner_unavailable`: start the runner and check `RUNNER_URL`. Redirects are deliberately refused so the API token is never forwarded to another origin.
- `unauthorized`: make `RUNNER_API_TOKEN` match the runner configuration.
- `runner_timeout`: the job may already be accepted. Recover or retry with the same request ID and inputs.
- `discovery_required` or `project_busy`: poll the existing work before starting another job.
- `repair_setup_required` or `repair_evidence_required`: inspect project commands and the failed/control evidence. A generated patch is not guaranteed for every application or run.

The MCP adapter does not launch arbitrary shell commands, start your application, apply patches, or replace the runner. Fixed project commands are part of the runner's existing private verification workflow. There is no hosted MCP endpoint or separate MCP job database.

The automated boundary tests use the official SDK client over real stdio against a local HTTP fixture: `pnpm exec vitest run tests/mcp.test.ts --maxWorkers=1`. Live model/browser acceptance is a separate check against a configured runner and application.
