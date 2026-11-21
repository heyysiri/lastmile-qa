# LastMile QA

Describe your audience, review generated synthetic testers, and run their journeys against a connected application. LastMile checks actual outcomes and keeps the evidence. Generated profiles are exploratory test cases, not measured human behavior.

## Run locally

Use Node 22+ and pnpm 10.33.0.

1. `pnpm install`
2. `pnpm exec playwright install chromium`
3. Copy `.env.example` to `.env` if it does not exist. Set `OPENAI_API_KEY` and an accessible `OPENAI_MODEL`. Credentials stay server-side.
4. `pnpm dev`

Dashboard: http://127.0.0.1:3000
Connected seller demo: http://127.0.0.1:3001
Runner: http://127.0.0.1:4000

Stop an existing stack before starting another. Root `.env` changes require a restart. No cloud resources or deployment are required at this checkpoint.

## First generated-audience checkpoint

The connected app currently supports store setup and inventory updates. Domain text helps describe the audience; it does not automatically connect another application or add business features. The generator uses registered workflow outcomes and current browser observations. It cannot invent backend fields or upload fixtures.

Try this audience brief with three testers:

> Test two different new sellers setting up their stores with distinct names and one experienced seller updating stock quantity. They all read English and use a pointer with normal connectivity. Keep tasks within the connected app capabilities. Generate different useful inputs and explain the assumptions.

1. Select the connected application and generate testers. Expect a real model-generated draft, not instant prefilled results. Generation does not start their journeys.
2. Review names, circumstances, coverage reasons, goals, inputs, assumptions and expected outcomes. Wording can vary between generations. Check that the proposed tasks match your intent.
3. Edit one tester's input or name, save, and reload. Expect your saved revision to persist. A stale edit should be rejected instead of silently overwriting another revision.
4. Launch the reviewed study. Expect up to three independent journeys to run concurrently, each in its own browser session and seller namespace. Refreshing the page must retain their progress.
5. Inspect each result. For normal conditions on the healthy demo, expect successful UI and backend assertions. A blocked agent or unavailable service remains inconclusive, never an invented product defect. Each completed journey links to its actual evidence.
6. Rerun the saved study. Expect a new execution with fresh state; previous results remain attached to their original snapshot.

`pnpm demo:study` performs an explicit paid live model acceptance run: generates three testers, launches them, checks separate namespaces, actual passing assertions and overlapping execution, and saves evidence to `artifacts/c1-checkpoint.json`. Run it intentionally; it is not part of routine unit tests. Pass a saved study ID (`pnpm demo:study <id>`) to rerun those same testers without regenerating them.

## What is and is not implemented

The browser engine uses an independent Strands agent per tester. Each has its own conversation, browser and starting state. Browser actions are sequential within a tester; study execution allows up to three testers concurrently. Each journey is capped at 20 model calls, 40 browser actions and 180 seconds.

The verifier independently checks visible UI and authenticated persisted state against the registered outcome contract. Changing a tester's goal does not silently rewrite its outcome contract. Review both before launch. Language, familiarity and background are behavioral guidance, not verified simulation of real people; browser locale does not translate the app. Viewports are emulated, not physical devices.

General application onboarding, richer starting-state/file integrations, evidence-backed repair proposals, patch approval, post-repair verification, optional voice input and AWS deployment are later checkpoints. No arbitrary external URL execution or autonomous application patches are enabled here.

The earlier replay and controlled-comparison engines remain available for corroborating verified failures. Their historical runs and configuration are retained. Lower-level configuration is an advanced workflow; it is no longer the product's starting point.

## Optional seeded failure demonstration

Healthy app behavior is the default. For a deliberately seeded timeout defect, stop the stack and run:

```sh
SELLER_DEMO_DEFECT=short-save-timeout pnpm dev
```

The seller app visibly labels this condition and cancels store saves after 700 ms. A context delaying `/api/store` requests by 1500 ms can expose it. A blocked exploration remains inconclusive; a compatible replay of a passing path can establish the outcome failure. Do not present this seeded defect as an issue discovered in an external marketplace.

`pnpm demo:seed` and `pnpm demo:investigate --scenario-id=network-onboarding --target-pack=network-delayed --control-pack=network-control` retain the earlier controlled-comparison acceptance path. Changing seller source or the defect flag invalidates old replay build identities.

## Verification and data

Run targeted tests for changed components. `pnpm typecheck`, scoped eslint and both Next builds verify the integrated workspace. Playwright UI tests use intercepted or isolated no-model APIs; explicit live scripts use OpenAI. The browser-seller integration test requires the seller app running.

SQLite databases are in `.data/`; evidence is in `artifacts/`. These, `.env`, project plans and local execution notes are ignored by Git. No production data migration, push, merge or deployment is implied. AWS deployment is the final planned stage after local acceptance.
