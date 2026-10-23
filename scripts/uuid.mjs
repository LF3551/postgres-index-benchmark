import { log, median, psql, readResults, size, timed, writeResults } from './lib.mjs';

// Random UUIDv4 against time-ordered UUIDv7 (PostgreSQL 18) as a primary key.
const ROWS = Number(process.env.UUID_ROWS || 5_000_000);
const REPS = Number(process.env.REPS || 3);
const variants = [
    { name: 'UUIDv4 (gen_random_uuid)', fn: 'gen_random_uuid()' },
    { name: 'UUIDv7 (uuidv7)', fn: 'uuidv7()' },
];

const out = [];
for (const v of variants) {
    const runs = [];
    let bytes = 0;
    for (let rep = 0; rep < REPS; rep++) {
        psql('DROP TABLE IF EXISTS k');
        psql(`CREATE TABLE k (id uuid PRIMARY KEY DEFAULT ${v.fn}, n int NOT NULL)`);
        psql('CHECKPOINT');
        runs.push(timed(() => psql(`INSERT INTO k (n) SELECT g FROM generate_series(1, ${ROWS}) g`)).ms);
        bytes = size('k_pkey');
    }
    out.push({ name: v.name, median_ms: median(runs), pk_bytes: bytes });
    log(`${v.name}: insert ${ROWS.toLocaleString('en-US')} rows ${(median(runs) / 1000).toFixed(1)} s, primary key ${(bytes / 1048576).toFixed(0)} MiB`);
}
psql('DROP TABLE IF EXISTS k');

const results = readResults();
results.uuid = { rows: ROWS, variants: out };
writeResults(results);
log('done, run: npm run report');
