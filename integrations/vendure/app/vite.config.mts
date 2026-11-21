import { vendureDashboardPlugin } from '@vendure/dashboard/vite';
import { pathToFileURL } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
    base: '/dashboard/',
    build: { outDir: 'dist/dashboard', emptyOutDir: true },
    plugins: [
        vendureDashboardPlugin({
            vendureConfigPath: pathToFileURL('./vendure-config.ts'),
            api: { host: 'auto', port: 'auto', tokenMethod: 'cookie' },
            tempCompilationDir: '.temp',
        }),
    ],
});
