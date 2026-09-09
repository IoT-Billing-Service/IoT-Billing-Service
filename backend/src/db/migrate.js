import { CacheStore } from './store.js';

const store = new CacheStore(process.argv[2] || './data/billing.db');
console.log('Migration applied');
store.close();
