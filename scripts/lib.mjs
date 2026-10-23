import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ROWS = Number(process.env.ROWS || 10_000_000);
export const REPS = Number(process.env.REPS || 3);

const RESULTS_DIR = path.join(ROOT, 'results');
const RESULTS_FILE = path.join(RESULTS_DIR, 'results.json');
const DB = process.env.PGDATABASE || 'bench';
// PGHOST set: use a local psql and your own server. Otherwise: psql inside the Docker container.
const LOCAL = Boolean(process.env.PGHOST);

export function psql(sql) {
    const args = ['-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c', sql];
    const opts = { encoding: 'utf8', maxBuffer: 1 << 28, cwd: ROOT, env: { ...process.env, PGDATABASE: DB } };
    const out = LOCAL
        ? execFileSync('psql', args, opts)
        : execFileSync('docker', ['compose', 'exec', '-T', 'db', 'psql', '-U', 'postgres', '-d', DB, ...args], opts);
    return out.trim();
}

export const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

export const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

export function timed(fn) {
    const t = process.hrtime.bigint();
    const value = fn();
    return { value, ms: Number(process.hrtime.bigint() - t) / 1e6 };
}

// ---- results store (results/ is git-ignored) -----------------------------
export function readResults() {
    return existsSync(RESULTS_FILE) ? JSON.parse(readFileSync(RESULTS_FILE, 'utf8')) : { rows: [] };
}
export function writeResults(results) {
    mkdirSync(RESULTS_DIR, { recursive: true });
    writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2));
}
export function record(row) {
    const results = readResults();
    results.rows = results.rows.filter(
        (r) => !(r.group === row.group && r.query === row.query && r.variant === row.variant),
    );
    results.rows.push(row);
    writeResults(results);
}

// ---- query plans ----------------------------------------------------------
function firstScan(node) {
    if (/Scan/.test(node['Node Type'])) return node;
    for (const child of node.Plans || []) {
        const found = firstScan(child);
        if (found) return found;
    }
    return null;
}

export function explain(sql) {
    const doc = JSON.parse(psql(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`))[0];
    const scan = firstScan(doc.Plan);
    const root = doc.Plan;
    return {
        ms: doc['Execution Time'],
        plan: scan ? scan['Node Type'] + (scan['Index Name'] ? ` (${scan['Index Name']})` : '') : '?',
        searches: scan?.['Index Searches'] ?? null, // PostgreSQL 18+
        buffers: (root['Shared Hit Blocks'] || 0) + (root['Shared Read Blocks'] || 0),
    };
}

// Hash of the full answer; with noIndex the planner is forced to read the table.
export function fingerprint(sql, { noIndex = false } = {}) {
    const off = noIndex
        ? 'SET enable_indexscan = off; SET enable_bitmapscan = off; SET enable_indexonlyscan = off; '
        : '';
    const out = psql(`${off}SELECT count(*) || ':' || coalesce(md5(string_agg(t::text, ',' ORDER BY t::text)), '') FROM (${sql}) t`);
    return out.split('\n').pop();
}

// Median over several parameter values; every answer is compared with a plain table scan.
export function measure(meta, makeSql, params = [0]) {
    const perParam = [];
    let first;
    for (const p of params) {
        const sql = makeSql(p);
        explain(sql); // warm-up
        const runs = Array.from({ length: REPS }, () => explain(sql));
        perParam.push(median(runs.map((r) => r.ms)));
        first ??= runs[0];
        if (fingerprint(sql) !== fingerprint(sql, { noIndex: true })) {
            throw new Error(`Index changed the answer: ${meta.group} / ${meta.variant} / ${sql}`);
        }
    }
    const row = { ...meta, ms: median(perParam), plan: first.plan, searches: first.searches, buffers: first.buffers };
    record(row);
    log(`${meta.group} ${meta.query} | ${meta.variant}: ${row.ms.toFixed(3)} ms, ${row.plan}`);
    return row;
}

// ---- index helpers --------------------------------------------------------
export const size = (index) => Number(psql(`SELECT pg_relation_size('${index}')`));

export function build(name, ddl) {
    const { ms } = timed(() => psql(ddl));
    return { build_ms: ms, bytes: size(name) };
}

export function dropIndexes(table = 'events', keep = `${table}_pkey`) {
    const names = psql(`SELECT indexname FROM pg_indexes WHERE tablename = '${table}' AND indexname <> '${keep}'`)
        .split('\n')
        .filter(Boolean);
    for (const name of names) psql(`DROP INDEX ${name}`);
}
