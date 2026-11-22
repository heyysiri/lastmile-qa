# GitHub demo

Use a trusted development repository. This runner executes its install, build and start commands locally. Vendure has automatic setup; other repositories need those commands and any development accounts supplied under Setup.

## Connect and run

Open [lastmile qa.](http://127.0.0.1:3000), choose **New project**, and use:

| Field | Value |
| --- | --- |
| Project name | Vendure release rehearsal |
| Repository | `https://github.com/heyysiri/vendure` |
| Branch | `lastmile-demo` |
| Setup | Automatic |
| Starting page | `/dashboard/` |

Audience and intent:

> Catalogue staff rename an existing product for a seasonal campaign, save their work, leave, and return to continue. Order operations staff review an existing placed order without changing it. Generate distinct behavioral personas for these workflows using laptop pointer interaction, including interrupted work and return visits where supported. A saved product name must remain complete and exactly as entered after returning. Preserve variant prices, inventory, order state and line items. Only edit existing product names; do not create or delete records or change permissions. Keep this study focused on product maintenance and order review, not table customization.

The runner clones the selected branch, installs and builds the native application, provisions synthetic staff accounts, and generates a team from repository evidence and observed screens. Team composition can vary between generations. Review the team, then select **Run test team** once.

## Follow the result

The demo branch deliberately contains a product-name truncation regression. It is an explicitly seeded demonstration, not a claim that upstream Vendure has this defect.

1. Inspect the failing journey's expected and observed values. The product form can display only the first three characters of the stored name. Passing controls should retain their original expectations.
2. When the run has complete failing evidence and passing controls, repair starts automatically. The runner reproduces the cases in a private application copy, proposes a patch, and verifies the same frozen checks without model calls during replay.
3. A verified patch is published automatically. Select **Review pull request** to inspect the exact source change and verification summary on GitHub. The original repository branch is not automatically merged.
4. Merge the PR manually on GitHub if satisfied. Return to the project and select **Sync & test**. Confirm the synced commit changed, existing tester and saved-case IDs remain, and the original failure is checked again. A sync consisting only of a recognized verified patch reuses coverage; other changes can generate additional coverage while retaining prior cases.

An inconclusive test is not a confirmed application defect. Incomplete evidence pauses automatic repair; a rejected or inconclusive patch is not published as verified. A verified result covers the recorded checks, not every behavior in the repository.

## Inspect without rerunning

Project details show the repository, branch, synced commit, last sync time and last tested commit. Team details show persona conditions and saved journeys. Run evidence shows expected versus observed values. Repair review shows the proposed source patch and replay outcome. These pages can be inspected without starting another model run.

## Restart this local demo

Run from the checkout holding the demo database, after stopping any previous instance on ports 3000 and 4002:

```sh
RUNNER_PORT=4002 QA_DATABASE_PATH=.data/github-demo-qa.sqlite RUNNER_URL=http://127.0.0.1:4002 pnpm --parallel --filter @lastmile/runner --filter @lastmile/lastmile start
```

The managed Vendure process starts when the project next runs or syncs. Its database and tester sessions are retained. The separate legacy seller-demo service is not needed for this flow.
