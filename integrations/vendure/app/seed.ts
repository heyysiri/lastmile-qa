import {
    AdministratorService,
    bootstrap,
    CustomerService,
    Importer,
    InitialData,
    JobQueueService,
    OrderService,
    Permission,
    Populator,
    ProductVariantService,
    RequestContextService,
    RoleService,
    UserService,
} from '@vendure/core';
import { existsSync, linkSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { lastValueFrom } from 'rxjs';
import { config, credentials, database, dataDir } from './vendure-config';

async function seed() {
    if (existsSync(database)) {
        console.log('Existing Vendure database preserved.');
        return;
    }
    // The fixture's type-only imports point at upstream source; the running app uses built packages.
    const loadFixture = createRequire(__filename);
    const { initialData } = loadFixture('../packages/core/mock-data/data-sources/initial-data') as {
        initialData: InitialData;
    };
    const staging = mkdtempSync(join(dataDir, 'seed-'));
    const seedDatabase = join(staging, 'vendure.sqlite');
    try {
        const app = await bootstrap({
            ...config,
            apiOptions: { ...config.apiOptions, port: 0 },
            dbConnectionOptions: { type: 'better-sqlite3', database: seedDatabase, synchronize: true },
        });
        try {
            await app.get(JobQueueService).start();
            const contexts = app.get(RequestContextService);
            const populator = app.get(Populator);
            await populator.populateInitialData({ ...initialData, roles: [] });
            const user = await app.get(UserService).getUserByEmailAddress(
                await contexts.create({ apiType: 'admin' }),
                config.authOptions.superadminCredentials!.identifier,
            );
            if (!user) throw new Error('Vendure did not initialize the manager account.');
            const ctx = await contexts.create({ apiType: 'admin', user });
            const csv = readFileSync(resolve('../packages/core/mock-data/data-sources/products.csv'), 'utf8');
            const progress = await lastValueFrom(
                app.get(Importer).parseAndImport(csv, ctx, false),
            );
            if (!progress.imported || progress.errors?.length) {
                throw new Error(`Upstream catalogue import failed: ${progress.errors?.join('; ')}`);
            }
            await populator.populateCollections(initialData);

            const staff = [
                {
                    code: 'catalog-staff',
                    description: 'Catalogue and inventory staff',
                    permissions: [Permission.ReadCatalog, Permission.UpdateCatalog, Permission.ReadStockLocation],
                    emailAddress: 'catalog@example.test',
                    firstName: 'Mara',
                    lastName: 'Chen',
                    password: credentials.catalog,
                },
                {
                    code: 'orders-staff',
                    description: 'Order operations staff',
                    permissions: [
                        Permission.ReadOrder, Permission.CreateOrder, Permission.UpdateOrder,
                        Permission.ReadCustomer, Permission.ReadCatalog, Permission.ReadShippingMethod,
                        Permission.ReadPaymentMethod, Permission.ReadCountry, Permission.ReadZone,
                    ],
                    emailAddress: 'orders@example.test',
                    firstName: 'Ellis',
                    lastName: 'Reed',
                    password: credentials.orders,
                },
            ];
            for (const { code, description, permissions, ...person } of staff) {
                const role = await app.get(RoleService).create(ctx, {
                    code, description, permissions, channelIds: [ctx.channelId],
                });
                await app.get(AdministratorService).create(ctx, { ...person, roleIds: [role.id] });
            }

            const variants = await app.get(ProductVariantService).findAll(ctx, { take: 3 });
            const customer = await app.get(CustomerService).create(ctx, {
                firstName: 'Nina', lastName: 'Patel', emailAddress: 'nina@example.test',
            });
            if (!('id' in customer)) throw new Error(customer.message);
            const orders = app.get(OrderService);
            for (const [index, variant] of variants.items.entries()) {
                const order = await orders.createDraft(ctx);
                await orders.updateOrderCustomer(ctx, { orderId: order.id, customerId: customer.id });
                const updated = await orders.addItemToOrder(ctx, order.id, variant.id, 1);
                if (!('id' in updated)) throw new Error(updated.message);

                // Leave two editable drafts and place one paid order using Vendure's order process.
                if (index === 0) {
                    await orders.setShippingAddress(ctx, order.id, {
                        fullName: 'Nina Patel',
                        streetLine1: '9 Example Lane',
                        city: 'London',
                        postalCode: 'EC1A 1BB',
                        countryCode: 'GB',
                    });
                    const [shipping] = await orders.getEligibleShippingMethods(ctx, order.id);
                    if (!shipping) throw new Error('No eligible fixture shipping method.');
                    const shipped = await orders.setShippingMethod(ctx, order.id, [shipping.id]);
                    if (!('id' in shipped)) throw new Error(shipped.message);
                    const payable = await orders.transitionToState(ctx, order.id, 'ArrangingPayment');
                    if (!('id' in payable)) throw new Error(payable.transitionError);
                    const paid = await orders.addManualPaymentToOrder(ctx, {
                        orderId: order.id,
                        method: 'standard-payment',
                        transactionId: 'sample-payment-1',
                        metadata: {},
                    });
                    if (!('state' in paid) || paid.state !== 'PaymentSettled') {
                        throw new Error('Vendure did not place the paid fixture order.');
                    }
                }
            }
        } finally {
            await app.close();
        }
        // SQLite is closed before publishing the fixture. A concurrent seed cannot replace it.
        linkSync(seedDatabase, database);
    } finally {
        rmSync(staging, { recursive: true, force: true });
    }
}

seed().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
