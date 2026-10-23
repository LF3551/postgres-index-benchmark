import { build, dropIndexes, log, measure, psql } from './lib.mjs';

// ONLY=A,B,P runs a subset (experiment ids are listed in the README).
const only = process.env.ONLY ? new Set(process.env.ONLY.toUpperCase().split(',')) : null;
const wanted = (id) => !only || only.has(id);
const drop = (name) => psql(`DROP INDEX IF EXISTS ${name}`);

psql('ANALYZE events');
dropIndexes();

const ids = Array.from({ length: 12 }, (_, i) => 1000 + i * 77_777);
const day = (d) => `timestamptz '2025-01-01+00' + interval '${d} days'`;
const hour = (h) => `timestamptz '2025-01-01+00' + interval '${h} hours'`;

// A. Point lookup: B-tree vs hash
if (wanted('A')) {
    const query = 'user_id = ?';
    const sql = (id) => `SELECT * FROM events WHERE user_id = ${id}`;
    measure({ group: 'A', query, variant: 'no index', baseline: true }, sql, ids.slice(0, 3));
    const btree = build('ix_user_btree', 'CREATE INDEX ix_user_btree ON events (user_id)');
    measure({ group: 'A', query, variant: 'B-tree', ...btree }, sql, ids);
    drop('ix_user_btree');
    const hash = build('ix_user_hash', 'CREATE INDEX ix_user_hash ON events USING hash (user_id)');
    measure({ group: 'A', query, variant: 'hash', ...hash }, sql, ids);
    drop('ix_user_hash');
}

// B. Range over time: B-tree vs BRIN (created_at follows the physical order of the table)
if (wanted('B')) {
    const query = 'one day of events';
    const days = [30, 90, 150, 210, 270, 330];
    const sql = (d) =>
        `SELECT count(*), avg(user_id) FROM events WHERE created_at >= ${day(d)} AND created_at < ${day(d + 1)}`;
    measure({ group: 'B', query, variant: 'no index', baseline: true }, sql, days.slice(0, 3));
    for (const [variant, name, ddl] of [
        ['B-tree', 'ix_ts_btree', 'CREATE INDEX ix_ts_btree ON events (created_at)'],
        ['BRIN', 'ix_ts_brin', 'CREATE INDEX ix_ts_brin ON events USING brin (created_at)'],
        ['BRIN, pages_per_range = 32', 'ix_ts_brin32', 'CREATE INDEX ix_ts_brin32 ON events USING brin (created_at) WITH (pages_per_range = 32)'],
    ]) {
        measure({ group: 'B', query, variant, ...build(name, ddl) }, sql, days);
        drop(name);
    }
}

// C. Partial index: newest failed events
if (wanted('C')) {
    const query = 'newest 50 failed events';
    const sql = () => `SELECT id, created_at FROM events WHERE status = 'failed' ORDER BY created_at DESC LIMIT 50`;
    measure({ group: 'C', query, variant: 'no index', baseline: true }, sql);
    measure({ group: 'C', query, variant: 'full (status, created_at)', ...build('ix_status_ts', 'CREATE INDEX ix_status_ts ON events (status, created_at)') }, sql);
    drop('ix_status_ts');
    measure({ group: 'C', query, variant: `partial (created_at) WHERE status = 'failed'`, ...build('ix_failed_ts', `CREATE INDEX ix_failed_ts ON events (created_at) WHERE status = 'failed'`) }, sql);
    drop('ix_failed_ts');
}

// D. Covering index (INCLUDE) and the visibility map
if (wanted('D')) {
    const query = 'created_at, status for one user';
    const sql = (id) => `SELECT created_at, status FROM events WHERE user_id = ${id}`;
    measure({ group: 'D', query, variant: 'B-tree (user_id)', baseline: true, ...build('ix_user_plain', 'CREATE INDEX ix_user_plain ON events (user_id)') }, sql, ids);
    drop('ix_user_plain');
    const cov = build('ix_user_cov', 'CREATE INDEX ix_user_cov ON events (user_id) INCLUDE (created_at, status)');
    measure({ group: 'D', query, variant: 'covering INCLUDE (table just vacuumed)', ...cov }, sql, ids);
    // Touching 1% of the rows spread over every page clears the visibility map bits.
    psql('UPDATE events SET status = status WHERE id % 100 = 0');
    measure({ group: 'D', query, variant: 'covering INCLUDE (after updating 1% of rows)', ...cov }, sql, ids);
    psql('VACUUM events');
    measure({ group: 'D', query, variant: 'covering INCLUDE (after VACUUM)', ...cov }, sql, ids);
    drop('ix_user_cov');
}

// E. Skip scan (PostgreSQL 18): the filter skips the leading column of the index
if (wanted('E')) {
    const query = 'one hour, filter only on created_at';
    const hours = [1000, 2500, 4000, 5500, 7000];
    const sql = (h) => `SELECT count(*) FROM events WHERE created_at >= ${hour(h)} AND created_at < ${hour(h + 1)}`;
    measure({ group: 'E', query, variant: 'no index', baseline: true }, sql, hours.slice(0, 3));
    measure({ group: 'E', query, variant: 'multicolumn (status, created_at)', ...build('ix_status_ts2', 'CREATE INDEX ix_status_ts2 ON events (status, created_at)') }, sql, hours);
    drop('ix_status_ts2');
}

// F. GIN: arrays and jsonb, plus parallel build (PostgreSQL 18)
if (wanted('F')) {
    const queries = {
        'array, rare tag': () => `SELECT count(*) FROM events WHERE tags @> ARRAY['rare']`,
        'array, common tag': () => `SELECT count(*) FROM events WHERE tags @> ARRAY['t42']`,
        'jsonb @>, rare (beta)': () => `SELECT count(*) FROM events WHERE payload @> '{"beta": true}'`,
        'jsonb @>, common (country + plan)': () => `SELECT count(*) FROM events WHERE payload @> '{"country": "DE", "plan": "team"}'`,
    };
    for (const [query, sql] of Object.entries(queries)) {
        measure({ group: 'F', query, variant: 'no index', baseline: true }, sql);
    }
    const gin = (name, ddl, workers = 4) => build(name, `SET max_parallel_maintenance_workers = ${workers}; ${ddl}`);

    const tags = gin('ix_tags_gin', 'CREATE INDEX ix_tags_gin ON events USING gin (tags)');
    for (const query of ['array, rare tag', 'array, common tag']) {
        measure({ group: 'F', query, variant: 'GIN (parallel build)', ...tags }, queries[query]);
    }
    drop('ix_tags_gin');
    const serial = gin('ix_tags_gin', 'CREATE INDEX ix_tags_gin ON events USING gin (tags)', 0);
    log(`GIN build: parallel ${(tags.build_ms / 1000).toFixed(1)} s, serial ${(serial.build_ms / 1000).toFixed(1)} s`);
    measure({ group: 'F', query: 'array, rare tag', variant: 'GIN (serial build)', ...serial }, queries['array, rare tag']);
    drop('ix_tags_gin');

    for (const [variant, name, ddl] of [
        ['GIN jsonb_ops (default)', 'ix_payload_gin', 'CREATE INDEX ix_payload_gin ON events USING gin (payload)'],
        ['GIN jsonb_path_ops', 'ix_payload_gin_path', 'CREATE INDEX ix_payload_gin_path ON events USING gin (payload jsonb_path_ops)'],
    ]) {
        const built = gin(name, ddl);
        for (const query of ['jsonb @>, rare (beta)', 'jsonb @>, common (country + plan)']) {
            measure({ group: 'F', query, variant, ...built }, queries[query]);
        }
        drop(name);
    }
}

// P. Pitfalls: the index exists, the planner does not use it (or should not)
if (wanted('P')) {
    psql('CREATE INDEX ix_ts ON events (created_at)');
    psql('CREATE INDEX ix_status ON events (status)');
    psql('ANALYZE events');
    const on = (where) => () => `SELECT avg(user_id) FROM events WHERE ${where}`;
    const dayStart = `timestamptz '2025-04-01+00'`;
    measure({ group: 'P', query: 'one day', variant: 'range on created_at' }, on(`created_at >= ${dayStart} AND created_at < ${dayStart} + interval '1 day'`));
    measure({ group: 'P', query: 'one day', variant: 'created_at::date = ... (function on the column)' }, on(`created_at::date = date '2025-04-01'`));
    psql(`CREATE INDEX ix_ts_date ON events (((created_at AT TIME ZONE 'UTC')::date))`);
    psql('ANALYZE events');
    measure({ group: 'P', query: 'one day', variant: 'expression index on the UTC date' }, on(`(created_at AT TIME ZONE 'UTC')::date = date '2025-04-01'`));
    drop('ix_ts_date');
    measure({ group: 'P', query: 'status', variant: `status = 'done' (most common value)` }, on(`status = 'done'`));
    measure({ group: 'P', query: 'status', variant: `status = 'archived' (rarest value)` }, on(`status = 'archived'`));
    drop('ix_ts');
    drop('ix_status');
}

log('done, run: npm run report');
