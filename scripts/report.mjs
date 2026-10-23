import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT, readResults } from './lib.mjs';

const results = readResults();
const rows = results.rows || [];
const titles = {
    A: 'A. Point lookup: B-tree vs hash',
    B: 'B. Range over time: B-tree vs BRIN',
    C: 'C. Partial index',
    D: 'D. Covering index (INCLUDE) and the visibility map',
    E: 'E. Skip scan (PostgreSQL 18)',
    F: 'F. GIN on arrays and jsonb',
    P: 'P. Pitfalls: when the planner ignores an index',
};

const size = (b) => (b == null ? '' : b >= 1048576 ? `${(b / 1048576).toFixed(1)} MiB` : `${(b / 1024).toFixed(0)} KiB`);
const ms = (v) => (v < 10 ? v.toFixed(3) : v < 100 ? v.toFixed(1) : v.toFixed(0));
const lines = [];
const out = (s = '') => lines.push(s);

if (results.dataset) {
    const d = results.dataset;
    out(`PostgreSQL ${d.version}, ${d.rows.toLocaleString('en-US')} rows, table ${size(d.table_bytes)}, primary key ${size(d.pk_bytes)}.`);
    out(`Correlation with physical order: created_at ${d.correlation.created_at}, user_id ${d.correlation.user_id}.`);
    out();
}

for (const [id, title] of Object.entries(titles)) {
    const group = rows.filter((r) => r.group === id);
    if (!group.length) continue;
    const hasBaseline = group.some((r) => r.baseline);
    out(`### ${title}`);
    out();
    out(`| Query | Variant | Plan | Time, ms | ${hasBaseline ? 'Speedup | ' : ''}Index size | Build, s | Buffers |`);
    out(`|---|---|---|---:|${hasBaseline ? '---:|' : ''}---:|---:|---:|`);
    for (const r of group) {
        const base = group.find((b) => b.baseline && b.query === r.query);
        const speed = hasBaseline ? `${base && !r.baseline ? `${(base.ms / r.ms).toFixed(1)}x` : ''} | ` : '';
        const plan = r.searches != null ? `${r.plan}, ${r.searches} index search${r.searches === 1 ? '' : 'es'}` : r.plan;
        out(`| ${r.query} | ${r.variant} | ${plan} | ${ms(r.ms)} | ${speed}${size(r.bytes)} | ${r.build_ms ? (r.build_ms / 1000).toFixed(1) : ''} | ${r.buffers} |`);
    }
    out();
}

if (results.writes) {
    const { runs, rows: n } = results.writes;
    out(`### G. Write cost: inserting ${n.toLocaleString('en-US')} rows (primary key plus N secondary indexes)`);
    out();
    out('| Secondary indexes | Insert time, s | vs primary key only |');
    out('|---:|---:|---:|');
    for (const r of runs) out(`| ${r.indexes} | ${(r.median_ms / 1000).toFixed(1)} | ${(r.median_ms / runs[0].median_ms).toFixed(1)}x |`);
    out();
}

if (results.uuid) {
    const { variants, rows: n } = results.uuid;
    out(`### H. Primary key type: inserting ${n.toLocaleString('en-US')} rows`);
    out();
    out('| Key | Insert time, s | Primary key size |');
    out('|---|---:|---:|');
    for (const v of variants) out(`| ${v.name} | ${(v.median_ms / 1000).toFixed(1)} | ${size(v.pk_bytes)} |`);
    out();
}

const text = lines.join('\n');
console.log(text);
mkdirSync(path.join(ROOT, 'results'), { recursive: true });
writeFileSync(path.join(ROOT, 'results', 'report.md'), text + '\n');
