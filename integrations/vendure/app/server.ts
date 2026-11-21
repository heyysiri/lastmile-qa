import { bootstrap, JobQueueService } from '@vendure/core';
import { existsSync } from 'node:fs';
import { config, database } from './vendure-config';

async function start() {
    if (!existsSync(database)) throw new Error('Run npm run seed before starting Vendure.');
    const app = await bootstrap(config);
    await app.get(JobQueueService).start();
}

start().catch(error => {
    console.error(error);
    process.exit(1);
});
