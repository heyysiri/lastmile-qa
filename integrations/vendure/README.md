# Vendure v3.5.0 development workspace

From this repository, run `node scripts/setup-vendure.mjs`. The script checks out Vendure commit `534e6003534f74761e82de1b8c6061cba89945d1`, installs its locked dependencies, builds the server and React dashboard, and seeds SQLite. Set `VENDURE_WORKSPACE` to choose a different checkout location. The default is `.local-work/p3/vendure-app`.

Run the native server from the prepared checkout:

```sh
cd .local-work/p3/vendure-app/local-marketplace
npm exec --yes --package=node@22.22.0 -- npm run start
```

Open [Vendure Dashboard](http://127.0.0.1:9005/dashboard/). Use `manager@example.test` for the superadministrator, `catalog@example.test` for catalogue editing, or `orders@example.test` for order operations. The synthetic passwords are the corresponding `manager`, `catalog`, and `orders` values in `local-marketplace/.data/credentials.json` inside the Vendure checkout. Setup generates them once. Keep that file alongside `local-marketplace/.data/vendure.sqlite` and the seeded assets.

The checkout is the source repository to connect. Edit upstream server code under `packages/core/src` and dashboard routes under `packages/dashboard/src/app/routes`. Stop the server with Ctrl-C, then run `npm exec --yes --package=node@22.22.0 -- npm run build` from `local-marketplace` and restart. Setup preserves existing local configuration files and skips seeding when SQLite already exists. The fixture includes stock, native draft orders, and an order with a simulated manual payment.
