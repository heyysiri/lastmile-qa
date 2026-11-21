# LastMile QA

A local testing workbench for configurable seller-marketplace journeys. Define a task, choose seller circumstances, and inspect evidence against explicit success criteria.

## Development

Use Node 22 and pnpm 10.33.0. SQLite and Playwright run locally.

1. `pnpm install`
2. `pnpm exec playwright install chromium`
3. Copy `.env.example` to `.env` and configure server-side settings. The local development tokens in the example are for loopback-only use.
4. `pnpm dev`

Dashboard: http://127.0.0.1:3000
Seller app: http://127.0.0.1:3001
Runner API: http://127.0.0.1:4000

`OPENAI_API_KEY` and an accessible `OPENAI_MODEL` are required for live AI execution. A ChatGPT/Codex subscription or connected Claude coding provider does not by itself supply an OpenAI API key. Never place API credentials in browser-exposed variables. No deployment or third-party marketplace connection is configured.

## Configuration boundaries

Scenarios contain goals, entry paths, starting-state fixtures, typed input slots and declarative outcome assertions. Context packs separately contain viewport, locale, language/familiarity guidance, interaction mode, reduced-motion preference, injected request-delay settings and input bindings. Adding another supported task should change configuration, not runner code.

The store onboarding and inventory definitions are editable starter examples. The demo app implements these business features; the engine must not branch on their IDs. Browser constraints and AI behavioral guidance are reported separately. This is not real-device testing or validated simulation of a demographic group.

## Tests

- `pnpm test:unit tests/contracts.test.ts` checks the shared configuration boundary.
- Run targeted test files for changed packages as recorded in the task reports.
- With the local stack running, `pnpm exec playwright test tests/foundation.spec.ts` exercises actual UI submission, backend persistence and immutable configuration snapshots.
- `pnpm typecheck`, `pnpm lint`, and `pnpm build` validate the integrated workspace.

## Build status

Implementation is in progress. The first milestone is real scenario/context authoring, runner storage and seller-app persistence. Browser AI execution, differential diagnosis and approved repair validation have separate acceptance gates; unavailable stages must produce explicit limitations, not passing verdicts.

Runtime databases live in `.data/`; evidence lives in `artifacts/`. Both are ignored by Git. Project plans, execution notes and child task reports also remain local.

## Foundation manual checkpoint

The dashboard and seller app are usable locally. The browser executor is not connected yet: launching a run records `completed` / `inconclusive` with “Browser execution is not configured yet”. It does not operate the seller app or produce defect evidence.

1. Open http://127.0.0.1:3001/onboarding and choose **Start demo session** if shown. Enter **Siri Crafts** as Store name and choose **Save store**. Expect **Store saved** and status **ready**; reload and the name stays.
2. Open http://127.0.0.1:3001/inventory. Enter **23** as stock quantity and choose **Save inventory**. Expect **Inventory saved** and stock **23** after reload.
3. Open http://127.0.0.1:3000/scenarios. Select **Set up a seller store**, choose **Duplicate**, set ID to **my-store-task** and Name to **My store setup**, then **Create**. Expect revision **1** and the new item after reload. Use another ID if it already exists.
4. Under **Context packs**, duplicate **Small-screen seller**, set ID to **siri-mobile**, Name to **Siri mobile**, and `storeName` to **Siri Crafts**. Keep viewport width **390**, then **Create**. Expect the saved pack after reload.
5. On **Run**, select the new scenario and context, then **Launch run**. Expect the explicit inconclusive result described above, the selected configuration revisions, no assertion results, and no artifacts. Reload and open **Run history** to confirm persistence.

Run the focused browser checks with the stack running:
`pnpm exec playwright test tests/foundation.spec.ts tests/dashboard.spec.ts tests/run-lifecycle.spec.ts tests/editor-races.spec.ts`
