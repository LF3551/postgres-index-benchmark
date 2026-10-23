import { dropIndexes, log, median, psql, readResults, timed, writeResults } from './lib.mjs';

const secondary = {
    0: [],
    1: ['CREATE INDEX w_user ON w (user_id)'],
    3: [
        'CREATE INDEX w_user ON w (user_id)',
        'CREATE INDEX w_ts ON w (created_at)',
        'CREATE INDEX w_status_ts ON w (status, created_at)',
    ],
    5: [
        'CREATE INDEX w_user ON w (user_id)',
        'CREATE INDEX w_ts ON w (created_at)',
        'CREATE INDEX w_status_ts ON w (status, created_at)',
        'CREATE INDEX w_tags ON w USING gin (tags)',
        'CREATE INDEX w_payload ON w USING gin (payload)',
    ],
};
const COPY_ROWS = Number(process.env.COPY_ROWS || 1_000_000);
const REPS = Number(process.env.REPS || 3);

dropIndexes();
const writes = [];
let copied = 0;
for (const [count, ddls] of Object.entries(secondary)) {
    const runs = [];
    for (let rep = 0; rep < REPS; rep++) {
        psql('DROP TABLE IF EXISTS w');
        psql(`CREATE TABLE w (
            id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            user_id int NOT NULL, status text NOT NULL, created_at timestamptz NOT NULL,
            tags text[] NOT NULL, payload jsonb NOT NULL)`);
        for (const ddl of ddls) psql(ddl);
        psql('CHECKPOINT');
        const { ms } = timed(() =>
            psql(`INSERT INTO w (user_id, status, created_at, tags, payload)
                  SELECT user_id, status, created_at, tags, payload FROM events WHERE id <= ${COPY_ROWS}`),
        );
        runs.push(ms);
        copied = Number(psql('SELECT count(*) FROM w'));
    }
    const row = { indexes: Number(count), median_ms: median(runs) };
    writes.push(row);
    log(`${copied.toLocaleString('en-US')} rows, primary key + ${count} secondary indexes: ${(row.median_ms / 1000).toFixed(1)} s`);
}
psql('DROP TABLE IF EXISTS w');

const results = readResults();
results.writes = { rows: copied, runs: writes };
writeResults(results);
log('done, run: npm run report');
