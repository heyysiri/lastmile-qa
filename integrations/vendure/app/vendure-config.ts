import { AssetServerPlugin } from '@vendure/asset-server-plugin';
import { DefaultJobQueuePlugin, DefaultSearchPlugin, VendureConfig, dummyPaymentHandler } from '@vendure/core';
import { DashboardPlugin } from '@vendure/dashboard/plugin';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const dataDir = resolve('.data');
export const database = resolve(dataDir, 'vendure.sqlite');
export const credentials = JSON.parse(readFileSync(resolve(dataDir, 'credentials.json'), 'utf8')) as {
    cookieSecret: string;
    manager: string;
    catalog: string;
    orders: string;
};

export const config: VendureConfig = {
    apiOptions: {
        hostname: '127.0.0.1',
        port: Number(process.env.PORT || 9005),
        adminApiPath: 'admin-api',
        shopApiPath: 'shop-api',
    },
    authOptions: {
        tokenMethod: 'cookie',
        cookieOptions: {
            name: { admin: 'marketplace-admin', shop: 'marketplace-shop' },
            secret: credentials.cookieSecret,
        },
        superadminCredentials: {
            identifier: 'manager@example.test',
            password: credentials.manager,
        },
    },
    dbConnectionOptions: { type: 'better-sqlite3', database },
    paymentOptions: { paymentMethodHandlers: [dummyPaymentHandler] },
    importExportOptions: { importAssetsDir: resolve('../packages/core/mock-data/assets') },
    plugins: [
        AssetServerPlugin.init({ route: 'assets', assetUploadDir: resolve(dataDir, 'assets') }),
        DefaultSearchPlugin.init({ bufferUpdates: false, indexStockStatus: true }),
        DefaultJobQueuePlugin.init({}),
        DashboardPlugin.init({ route: 'dashboard', appDir: resolve('dist/dashboard'), viteDevServerPort: 9006 }),
    ],
};
