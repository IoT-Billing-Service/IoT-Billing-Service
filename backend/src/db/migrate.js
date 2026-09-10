import { CacheStore } from './store.js';

const dbPath = process.argv[2] || './data/billing.db';
const databaseUrl = process.env.DATABASE_URL || null;

const store = await new CacheStore({ dbPath, databaseUrl }).ready();
console.log(
  databaseUrl
    ? `Migrations applied (postgres ${databaseUrl.split('@').pop()})`
    : `Migrations applied (sqlite ${dbPath})`,
);
await store.close();
