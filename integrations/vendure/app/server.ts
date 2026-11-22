import { bootstrap, JobQueueService } from '@vendure/core';
import { existsSync } from 'node:fs';
import { config, database } from './vendure-config';

async function start() {
    if (!Number.isInteger(config.apiOptions.port) || config.apiOptions.port < 1 || config.apiOptions.port > 65535) {
        throw new Error('Set PORT to the managed loopback port before starting Vendure.');
    }
    if (!existsSync(database)) throw new Error('Run npm run seed before starting Vendure.');
    const app = await bootstrap(config);
    await app.get(JobQueueService).start();
}

start().catch(error => {
    console.error(error);
    process.exit(1);
});
