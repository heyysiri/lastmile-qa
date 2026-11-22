# Warehouse shift demo

Open [Vendure warehouse shift](http://127.0.0.1:3000/projects/7ed2afad-e6b5-4a11-88b6-8644480ae314).

This is a fresh managed checkout of `https://github.com/heyysiri/vendure`, branch `lastmile-demo`. It uses model-generated personas and checks, not manually authored selectors. Its branch already includes the previous product-name repair.

## What to inspect

1. Open the team details. The warehouse lead has an experienced stock-counting background, a laptop viewport, 800 ms latency, 1,200 Kbps download and 600 Kbps upload. The temporary catalogue assistant is a first-time user on a normal connection. The order operations colleague has a separate account and a read-only task.
2. Open the latest completed run. All three journeys and nine checks passed in 123 seconds. Stock changed from 100 to 111. The warehouse browser closed and reopened; a stage-entry check read 111 before any actor action on return. The SKU remained L2201308.
3. Inspect the other results. The full product name persisted after reopening; the existing variant remained listed. Order code and line-item checks passed during review and after reload.
4. Open History. Browser URLs and raw observations are under the closed **Browser details** dropdown.

The earlier inconclusive run remains in history. It exposed a harness timing problem: the verifier checked a still-loading form after two seconds. The corrected verifier waits for controls under emulated slow connectivity, then reads their values once. A wrong value still fails. The same generated personas, goals and expectations were rerun after restoring only this demo's own pre-run database.

## Recreate the study

Choose **New project**, the repository and branch above, automatic setup, and starting page `/dashboard/`. Supply this audience and intent:

> A small retailer is preparing for a busy sales weekend. A warehouse stock lead works on a laptop over slow warehouse Wi-Fi: after a physical count, they correct an existing product variant's stock, save, close the browser to unload a delivery, and return to continue. A temporary catalogue assistant is less familiar with the dashboard and prepares an existing product name for the weekend campaign using a normal connection. An order operations colleague reviews an already placed order to answer a customer's delivery question, without changing it. Generate distinct behavioral personas for these actual jobs, including a genuinely throttled connection for the warehouse worker and staged leave/return visits. Use existing records, editable form fields, and read-only order details; avoid saved table views or dashboard customization. Choose a compact, executable set of journeys rather than many shallow cases.

Under **Add requirements**, use:

> After a stock correction is saved, returning to the same variant must show the exact new stock-on-hand quantity before the tester edits anything again. Correcting stock must preserve that variant's price and SKU. A product-name-only edit must persist the complete entered name when the user returns and must preserve its variant inventory and prices. Reviewing an existing placed order must preserve its order status and line items. Slow connectivity may make the work slower, but must not silently change the values that are saved. Only edit an existing stock quantity and an existing product name. Do not create or delete records, submit orders, change payment/shipping state, or modify permissions. Do not assume offline editing or unsaved draft recovery is supported.

Generated names, inputs and coverage may vary. Inspect the generated gaps instead of assuming every requirement was covered.

## Limits of this evidence

This healthy-branch run did not trigger a repair or new PR. The earlier release rehearsal demonstrated the failing-case → private repair → frozen verification → PR flow.

The generated plan explicitly lacks stable checks for price preservation, catalogue-edit inventory preservation and exact order-status preservation. Visible order-line presence does not prove every line attribute is unchanged. These remain coverage gaps. Browser reopening is a real new browser context, not proof of days of elapsed usage. Network throttling is Chromium emulation, not a carrier outage simulation. One successful run does not establish superiority over coding agents.

Verified run: `e714a015-6063-4624-9cfb-6ffc960a7dba`. Original inconclusive run: `01421339-f72a-4c83-924e-16816e31784d`.
