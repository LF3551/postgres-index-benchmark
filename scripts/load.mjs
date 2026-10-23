import { ROWS, log, psql, size, timed, writeResults } from './lib.mjs';

const versionNum = Number(psql('SHOW server_version_num'));
if (versionNum < 180000) {
    log(`PostgreSQL ${psql('SHOW server_version')}: skip scan and "Index Searches" need 18 or newer, those rows will differ.`);
}

psql('DROP TABLE IF EXISTS events');
psql(`CREATE TABLE events (
    id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id    int         NOT NULL,
    status     text        NOT NULL,
    created_at timestamptz NOT NULL,
    tags       text[]      NOT NULL,
    payload    jsonb       NOT NULL
)`);

// Fixed seed: every run produces the same data. created_at grows with id (one row every 3 seconds).
const load = `
SET synchronous_commit = off;
SELECT setseed(0.42);
INSERT INTO events (user_id, status, created_at, tags, payload)
SELECT
    1 + floor(random() * 1000000)::int,
    CASE WHEN r < 0.70   THEN 'done'
         WHEN r < 0.90   THEN 'active'
         WHEN r < 0.99   THEN 'pending'
         WHEN r < 0.9985 THEN 'failed'
         ELSE 'archived' END,
    timestamptz '2025-01-01 00:00:00+00' + g * interval '3 seconds',
    CASE WHEN random() < 0.0001
         THEN ARRAY['rare', 't' || (1 + floor(random() * 200))::int]
         ELSE ARRAY['t' || (1 + floor(random() * 200))::int, 't' || (1 + floor(random() * 200))::int] END,
    jsonb_build_object(
        'country', (ARRAY['US','DE','IN','GB','FR','BR','PL','NL','CA','JP'])[1 + floor(random() * 10)::int],
        'plan',    (ARRAY['free','pro','team','enterprise'])[1 + floor(random() * 4)::int],
        'device',  (ARRAY['web','ios','android'])[1 + floor(random() * 3)::int],
        'beta',    random() < 0.0005)
FROM (SELECT g, random() AS r FROM generate_series(1, ${ROWS}) g) s;`;

log(`loading ${ROWS.toLocaleString('en-US')} rows`);
const { ms } = timed(() => psql(load));
psql('VACUUM (ANALYZE) events');

const results = { rows: [] };
results.dataset = {
    rows: Number(psql('SELECT count(*) FROM events')),
    table_bytes: Number(psql(`SELECT pg_relation_size('events')`)),
    pk_bytes: size('events_pkey'),
    version: psql('SHOW server_version'),
    load_s: ms / 1000,
    correlation: Object.fromEntries(
        psql(`SELECT attname || '=' || round(correlation::numeric, 3) FROM pg_stats WHERE tablename = 'events' AND attname IN ('created_at', 'user_id')`)
            .split('\n')
            .map((line) => line.split('=')),
    ),
};
writeResults(results);
log('loaded', JSON.stringify(results.dataset));
