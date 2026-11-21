# LastMile QA

Describe your audience, review generated synthetic testers, and enroll them as persistent customers of your staging application. Keep their accounts and observed history across releases, then check whether the same customer tasks still work from identical saved starting states. Generated profiles are exploratory test cases, not measured human behavior.

## Run locally

Use Node 22+ and pnpm 10.33.0.

1. `pnpm install`
2. `pnpm exec playwright install chromium`
3. Copy `.env.example` to `.env` if it does not exist. Set `OPENAI_API_KEY` and an accessible `OPENAI_MODEL`. Credentials stay server-side.
4. `pnpm build` then `pnpm start` for release checks. Use `pnpm dev` while editing code.

Dashboard: http://127.0.0.1:3000
Connected seller demo: http://127.0.0.1:3001
Runner: http://127.0.0.1:4000

The built local stack avoids development hot reloads changing the page during a replay. Rebuild after source edits; the runner rejects seller source or requirements that differ from the compiled release stamp. Stop an existing stack before starting another. Root `.env` changes require a restart. No cloud resources or deployment are required at this checkpoint.

## Persistent customer checkpoint

Start with two testers, one updating inventory and one setting up a store. Review and save their tasks, then enroll them as a persistent population. Continuing a population reopens those same accounts; running a fresh study still creates isolated new accounts.

1. Give the inventory tester `quantity: 250` and the store tester `storeName: Fresh Market`. Continue both journeys on the healthy app. Expect passing checks and separate account identities.
2. For the next journey, choose store setup/profile editing for both testers. Use `Returning Craft Shop` and `Fresh Market Studio` as their respective store names. Expect the same account identities, one prior observation per tester, and successful saves. The stock preservation checks should expect 250 and 5 respectively.
3. This successful execution can serve as a release baseline. A checkpoint comparison copies each tester's saved starting state, original inputs, assertions and recorded browser actions into a separate account. It makes **no model calls** and leaves the original accounts untouched.
4. To demonstrate a history-dependent regression, stop the idle stack and restart with `SELLER_DEMO_DEFECT=reset-stock-on-store-save pnpm start`. Compare against the healthy profile-update baseline. Expect the returning seller to fail stock preservation (250 expected, 5 observed) while the default-stock seller passes. The seller app labels this deliberately seeded defect.
5. Stop the idle stack and restart with `pnpm start` to restore healthy behavior. Compare against the **same original baseline**. Expect both checks to pass. This demonstrates independent rechecking, not an autonomous coding-agent repair.

A replay that cannot reproduce the browser actions is inconclusive, not proof of a regression. Persistent comparisons use the population workflow; legacy replay/investigation endpoints are for fresh-session runs.

Application context lists explicitly configured code and requirements with content digests, and is frozen with each release execution. It is a traceable source manifest, not automatic understanding of an arbitrary repository. Browser testers receive only their own latest visible observations, profile and task; they cannot read source code or the verifier's trusted state.

For a quick check of the prepared population, choose **Compare a release**, enter `My manual check`, select **Healthy profile update**, and click **Run checkpoint comparison**. Expect two still passing, zero regressions, and zero model calls. Refresh the result page; the same results should remain.

To advance the actual customers, choose **Continue their journeys** with release label `My returning users`. Set the first tester's workflow to **Update stock quantity** with quantity `300`. Set the second to **Set up a seller store** with store name `Manual Market`. Expect two passing journeys and one additional observed history entry per tester, on their original accounts. This makes model calls. Comparing the old baseline afterward still uses its frozen stock values of 250 and 5, without resetting the current accounts.

## Generate the initial audience

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

General application onboarding, automatic next-task proposals, richer file integrations, evidence-backed repair proposals, patch approval, genuine post-repair verification and AWS deployment are later checkpoints. No arbitrary external URL execution or autonomous application patches are enabled here.

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

SQLite databases are in `.data/`; evidence is in `artifacts/`. Evidence includes screenshots, semantic steps, assertions and sanitized network diagnostics. Raw Playwright trace archives are not exported because they contain session credentials; legacy raw trace downloads are also disabled. These, `.env`, project plans and local execution notes are ignored by Git. No production data migration, push, merge or deployment is implied. AWS deployment is the final planned stage after local acceptance. AWS is for hosting only; no AWS AI or memory services are used.
