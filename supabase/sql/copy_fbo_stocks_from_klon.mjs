import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLONE_REF = "dadxhygirafgzpcbbepb";
const CUT = "2026-07-27";
const EXTRACT_DAYS = 14;
const INSERT_CHUNK = 800;

function query(sql, projectRef) {
  const dir = mkdtempSync(join(tmpdir(), "wb-sql-"));
  const file = join(dir, "q.sql");
  writeFileSync(file, sql, "utf8");
  const args = ["supabase", "db", "query", "--linked", "-f", file];
  if (projectRef) args.push("--project-ref", projectRef);
  const npx = process.platform === "win32" ? "npx.cmd" : "npx";
  let out;
  try {
    out = execFileSync(npx, args, {
      cwd: process.cwd(),
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      shell: process.platform === "win32",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const start = out.indexOf("{");
  if (start < 0) throw new Error("no json in db query output");
  const parsed = JSON.parse(out.slice(start));
  if (parsed._tag === "Error") throw new Error(JSON.stringify(parsed.error));
  return parsed;
}

function dateAdd(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function insertSql(chunk) {
  const b64 = Buffer.from(JSON.stringify(chunk), "utf8").toString("base64");
  return `insert into public.fbo_stocks (
  seller_id, snapshot_date, nm_id, warehouse_name,
  quantity, extra, payload, loaded_at
)
select
  (r->>'seller_id')::uuid,
  (r->>'snapshot_date')::date,
  r->>'nm_id',
  r->>'warehouse_name',
  (r->>'quantity')::numeric,
  coalesce(r->'extra', '{}'::jsonb),
  coalesce(r->'payload', '{}'::jsonb),
  coalesce((r->>'loaded_at')::timestamptz, now())
from jsonb_array_elements(
  convert_from(decode('${b64}', 'base64'), 'utf8')::jsonb
) r
on conflict do nothing;`;
}

const dates = query(
  `select min(snapshot_date)::text as min_d, max(snapshot_date)::text as max_d
   from public.fbo_stocks
   where snapshot_date < date '${CUT}'`,
  CLONE_REF
).rows[0];

console.log(`clone old range ${dates.min_d} .. ${dates.max_d}`);

const all = [];
let from = dates.min_d;
while (from < CUT) {
  const to = dateAdd(from, EXTRACT_DAYS) < CUT ? dateAdd(from, EXTRACT_DAYS) : CUT;
  const extracted = query(
    `select coalesce(jsonb_agg(to_jsonb(s) order by s.seller_id, s.snapshot_date, s.nm_id, s.warehouse_name), '[]'::jsonb) as batch
     from public.fbo_stocks s
     where s.snapshot_date >= date '${from}'
       and s.snapshot_date < date '${to}'`,
    CLONE_REF
  );
  const batch = extracted.rows[0].batch;
  const rows = typeof batch === "string" ? JSON.parse(batch) : batch;
  console.log(`extract ${from} .. ${to}: ${rows.length}`);
  all.push(...rows);
  from = to;
}

console.log(`extracted ${all.length} rows, inserting`);

const statements = [];
for (let i = 0; i < all.length; i += INSERT_CHUNK) {
  statements.push(insertSql(all.slice(i, i + INSERT_CHUNK)));
}

const FILE_STMTS = 4;
for (let i = 0; i < statements.length; i += FILE_STMTS) {
  const sql = statements.slice(i, i + FILE_STMTS).join("\n");
  query(sql, null);
  const n = Math.min(i + FILE_STMTS, statements.length);
  console.log(`insert files ${i + 1}-${n}/${statements.length}`);
}

const prod = query(
  `select min(snapshot_date)::text as min_d,
          max(snapshot_date)::text as max_d,
          count(*)::int as rows,
          count(*) filter (where snapshot_date < date '${CUT}')::int as old_rows
   from public.fbo_stocks`,
  null
).rows[0];

console.log(
  `prod min=${prod.min_d} max=${prod.max_d} rows=${prod.rows} old=${prod.old_rows}`
);
