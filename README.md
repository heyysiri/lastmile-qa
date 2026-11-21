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
- Dashboard/lifecycle tests use an isolated runner with the no-model executor; they never call OpenAI. `tests/browser-seller.integration.test.ts` needs the seller app running. `demo:investigate` explicitly exercises live OpenAI execution and comparison.
- `pnpm typecheck`, `pnpm lint`, and `pnpm build` validate the integrated workspace.

## Current checkpoint

The runner uses Strands with the configured OpenAI model for browser exploration. Only independent UI and authenticated state assertions assign the result. Runs record actions, screenshots, a Playwright trace, HTTP/transport evidence, configuration snapshots and the served source identity.

A passing AI run can be replayed under another saved context without model calls. Changed controls, routes or keyboard focus produce `replay_mismatch` / inconclusive. A failed replay can be compared with the passing control: two target trials, two control trials, then two trials per single-factor substitution within the selected attempt budget. Guidance settings must match; only configured enforced factors enter the search.

Coding-agent repair, patch approval and post-repair verification remain for the following checkpoint. File uploads are rejected until approved fixtures are registered. Language/familiarity are behavioral guidance, not validated human simulation; viewport emulation is not a real device. The runtime is one local runner per database and port.

Runtime databases live in `.data/`; evidence lives in `artifacts/`. Both are ignored by Git. Project plans, execution notes and child task reports also remain local.

## Manual AI and comparison checkpoint

Set `OPENAI_API_KEY` and `OPENAI_MODEL` in the root `.env`. Restart the stack after changing them. Keep credentials out of chat, browser variables and commits. Launching an AI journey uses the configured API account; the runner caps it at 20 model calls, 40 browser steps and 180 seconds. Replays use zero model calls.

For the explicitly labeled seeded demonstration, start with:

```sh
SELLER_DEMO_DEFECT=short-save-timeout pnpm dev
```

This local app variant aborts store saves after 700 ms. It is an intentional defect for testing, not a claim about an actual marketplace. Plain `pnpm dev` leaves this defect off unless set in `.env`. Stop the existing stack before starting another.

In another terminal:

```sh
pnpm demo:seed
pnpm demo:investigate --scenario-id=network-onboarding --target-pack=network-delayed --control-pack=network-control
```

`demo:seed` creates editable example definitions and leaves existing IDs unchanged. The control and target share seller inputs, viewport and guidance; only `/api/store` request delay changes from normal to 1500 ms. The engine never branches on these task or pack IDs.

For manual testing at http://127.0.0.1:3000:

1. Select **Store setup under delayed requests** and **Seller · normal requests**, then **Launch run**. Expect independent assertions to pass and recorded browser evidence.
2. On that passing run, choose **Seller · delayed requests** under **Replay context**, then **Replay this path**. Expect the store outcome checks to fail, with request-delay evidence. If controls or the source build changed, expect an inconclusive replay instead.
3. On the failed run, select the original normal-request run as **Passing control**, keep **network** selected and budget **6**, then **Investigate differences**. Expected seeded result: target fails twice, control passes twice, changing only network passes twice; contributing condition **network**.
4. Open any trial's evidence. `final.png` shows the actual page; `assertions.json` and `readback.json` show independently checked values; `network.json` distinguishes HTTP errors from transport failures; download `trace.zip` for `pnpm exec playwright show-trace <file>`.
5. Try **Update stock quantity** with **Desktop seller**. It uses the same engine and its own configured input and persisted-state assertions. No engine change is needed to duplicate/edit the scenario or context.

An AI agent may get stuck. Such a run stays **inconclusive**, even if the goal is unmet. Use a passed path's replay under the target context to corroborate an outcome; the product does not relabel the blocked AI attempt as a verified defect. Changing seller source invalidates previously recorded replays; create a fresh passing run.
