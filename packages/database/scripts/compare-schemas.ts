/**
 * Compare the structure of two PostgreSQL databases table by table
 * (HeoPress P02 task 7.1: the migration baseline must produce the same
 * structure as the old migration chain minus the removed tables).
 *
 *   tsx scripts/compare-schemas.ts <left-url> <right-url> [--schema public]
 *   tsx scripts/compare-schemas.ts --dump <url> [--schema public] | sha256sum
 *
 * Compared per table: columns (type, nullability, default — physical column
 * order is ignored), constraints (name, kind and definition), and indexes
 * (name and definition); plus the set of tables, views, sequences and enum
 * types. Prints every difference and exits 1 when there is any, 0 when the
 * two structures are identical. `--dump` prints one database's snapshot in a
 * canonical sorted form instead; its SHA-256 is the structure hash recorded in
 * UPSTREAM.md (task 7.2). Read-only.
 */
import postgres from 'postgres';

type Sql = ReturnType<typeof postgres>;

interface Snapshot {
  tables: Map<string, string[]>;
  views: string[];
  sequences: string[];
  enums: string[];
}

async function snapshot(sql: Sql, schema: string): Promise<Snapshot> {
  const tables = new Map<string, string[]>();
  const add = (table: string, line: string) => {
    if (!tables.has(table)) tables.set(table, []);
    tables.get(table)!.push(line);
  };

  const tableRows = await sql<{ table: string }[]>`
    SELECT c.relname AS table FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = ${schema} AND c.relkind IN ('r', 'p')`;
  for (const r of tableRows) tables.set(r.table, []);

  const columns = await sql<{ table: string; column: string; type: string; notnull: boolean; def: string | null }[]>`
    SELECT c.relname AS table, a.attname AS column, format_type(a.atttypid, a.atttypmod) AS type,
           a.attnotnull AS notnull, pg_get_expr(d.adbin, d.adrelid) AS def
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE n.nspname = ${schema} AND c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped`;
  for (const c of columns) {
    add(c.table, `column ${c.column} ${c.type}${c.notnull ? ' NOT NULL' : ''}${c.def ? ` DEFAULT ${c.def}` : ''}`);
  }

  const constraints = await sql<{ table: string; name: string; type: string; def: string }[]>`
    SELECT c.relname AS table, con.conname AS name, con.contype AS type, pg_get_constraintdef(con.oid) AS def
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = ${schema}`;
  for (const c of constraints) add(c.table, `constraint ${c.name} [${c.type}] ${c.def}`);

  const indexes = await sql<{ table: string; name: string; def: string }[]>`
    SELECT tablename AS table, indexname AS name, indexdef AS def FROM pg_indexes WHERE schemaname = ${schema}`;
  for (const i of indexes) add(i.table, `index ${i.name} ${i.def}`);

  const views = await sql<{ name: string; def: string }[]>`
    SELECT viewname AS name, definition AS def FROM pg_views WHERE schemaname = ${schema}`;
  const sequences = await sql<{ name: string }[]>`
    SELECT sequencename AS name FROM pg_sequences WHERE schemaname = ${schema}`;
  const enums = await sql<{ name: string; labels: string }[]>`
    SELECT t.typname AS name, string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) AS labels
    FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = ${schema} GROUP BY t.typname`;

  for (const lines of tables.values()) lines.sort();
  return {
    tables,
    views: views.map((v) => `${v.name}: ${v.def}`).sort(),
    sequences: sequences.map((s) => s.name).sort(),
    enums: enums.map((e) => `${e.name}: ${e.labels}`).sort(),
  };
}

function diffLists(label: string, left: string[], right: string[], out: string[]): void {
  const l = new Set(left);
  const r = new Set(right);
  for (const x of left) if (!r.has(x)) out.push(`${label}: only left  ${x}`);
  for (const x of right) if (!l.has(x)) out.push(`${label}: only right ${x}`);
}

/** Canonical text form of a snapshot: one line per object, sorted, column order ignored. */
export function formatSnapshot(s: Snapshot): string {
  const lines: string[] = [];
  for (const table of [...s.tables.keys()].sort()) {
    lines.push(`table ${table}`);
    for (const line of s.tables.get(table)!) lines.push(`  ${line}`);
  }
  for (const v of s.views) lines.push(`view ${v}`);
  for (const q of s.sequences) lines.push(`sequence ${q}`);
  for (const e of s.enums) lines.push(`enum ${e}`);
  return `${lines.join('\n')}\n`;
}

export function compareSnapshots(left: Snapshot, right: Snapshot): string[] {
  const out: string[] = [];
  diffLists('table', [...left.tables.keys()], [...right.tables.keys()], out);
  for (const [table, lines] of left.tables) {
    const other = right.tables.get(table);
    if (other) diffLists(table, lines, other, out);
  }
  diffLists('view', left.views, right.views, out);
  diffLists('sequence', left.sequences, right.sequences, out);
  diffLists('enum', left.enums, right.enums, out);
  return out;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const schemaIdx = args.indexOf('--schema');
  const schema = schemaIdx === -1 ? 'public' : args[schemaIdx + 1]!;
  const [leftUrl, rightUrl] = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--schema');
  if (args.includes('--dump') && leftUrl) {
    const db = postgres(leftUrl, { max: 1, onnotice: () => {} });
    try {
      process.stdout.write(formatSnapshot(await snapshot(db, schema)));
    } finally {
      await db.end({ timeout: 1 });
    }
    return;
  }
  if (!leftUrl || !rightUrl) {
    console.error('usage: tsx scripts/compare-schemas.ts <left-url> <right-url> [--schema public]');
    console.error('       tsx scripts/compare-schemas.ts --dump <url> [--schema public]');
    process.exit(2);
  }
  const left = postgres(leftUrl, { max: 1, onnotice: () => {} });
  const right = postgres(rightUrl, { max: 1, onnotice: () => {} });
  try {
    const [a, b] = await Promise.all([snapshot(left, schema), snapshot(right, schema)]);
    const diffs = compareSnapshots(a, b);
    const objects = [...a.tables.values()].reduce((n, l) => n + l.length, 0);
    if (diffs.length > 0) {
      console.error(`[compare-schemas] ${diffs.length} difference(s):`);
      for (const d of diffs) console.error(`  ${d}`);
      process.exitCode = 1;
    } else {
      console.log(`[compare-schemas] identical: ${a.tables.size} tables, ${objects} columns/constraints/indexes`);
    }
  } finally {
    await Promise.all([left.end({ timeout: 1 }), right.end({ timeout: 1 })]);
  }
}

if (process.argv[1]?.endsWith('compare-schemas.ts')) {
  void main();
}
