// Replay evals (planning/model-providers.md §9). Runs each case through the real agent loop and
// tools against the local database, then checks what was written.
//
//   pnpm eval                                   # default routing
//   pnpm eval --model anthropic/claude-haiku-4-5
//   pnpm eval --cases cases/log-entry.json
import { runTurn } from "@pa/agent";
import { closePool, getPool } from "@pa/db";
import { createModelRouter, keysFromEnv, loadModelConfig, type ModelRef, type ModelTask } from "@pa/models";
import { createConversation, ensureUser, slugify, toLocalIso } from "@pa/services";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

type ExpectedEntry = { activity: string; category?: string; duration_min?: number; started_at?: string; metrics?: Record<string, unknown> };
type Case = { id: string; text: string; expect: { entries: ExpectedEntry[]; forbid_activities?: string[] } };
type Suite = { task: ModelTask; now: string; timezone: string; pass_rate: number; cases: Case[] };

const { values } = parseArgs({ options: { cases: { type: "string", default: "cases/log-entry.json" }, model: { type: "string" } } });
const suite: Suite = JSON.parse(readFileSync(values.cases!, "utf8"));
const now = new Date(suite.now);

// Providers, catalog, and routes come from MODEL_CONFIG like the app; --model overrides the suite's task.
const config = loadModelConfig({
  ...(process.env.MODEL_CONFIG ? JSON.parse(process.env.MODEL_CONFIG) : {}),
  ...(values.model ? { routes: { ...JSON.parse(process.env.MODEL_CONFIG || "{}").routes, [suite.task]: { primary: values.model as ModelRef } } } : {}),
});
const routes = config.routes;
const models = createModelRouter(config, keysFromEnv(config));
const pool = getPool();

function check(expected: ExpectedEntry[], forbid: string[], rows: Record<string, any>[], tz: string): string[] {
  const problems: string[] = [];
  const remaining = [...rows];
  for (const exp of expected) {
    const i = remaining.findIndex((r) => r.activity === slugify(exp.activity));
    if (i < 0) {
      problems.push(`missing entry for ${exp.activity}`);
      continue;
    }
    const row = remaining.splice(i, 1)[0]!;
    if (exp.category && row.category !== exp.category) problems.push(`${exp.activity}: category ${row.category} ≠ ${exp.category}`);
    if (exp.duration_min !== undefined && row.duration_min !== exp.duration_min) problems.push(`${exp.activity}: duration ${row.duration_min} ≠ ${exp.duration_min}`);
    if (exp.started_at && toLocalIso(row.started_at, tz) !== exp.started_at) problems.push(`${exp.activity}: started_at ${toLocalIso(row.started_at, tz)} ≠ ${exp.started_at}`);
    for (const [k, v] of Object.entries(exp.metrics ?? {})) if (row.metrics?.[k] !== v) problems.push(`${exp.activity}: metrics.${k} ${row.metrics?.[k]} ≠ ${v}`);
  }
  for (const r of remaining) problems.push(`unexpected entry ${r.activity}`);
  for (const f of forbid) if (rows.some((r) => r.activity === slugify(f))) problems.push(`forbidden entry ${f}`);
  return problems;
}

let passed = 0;
for (const c of suite.cases) {
  const user = await ensureUser(pool, `eval-${randomUUID()}`);
  await pool.query(`UPDATE users SET timezone = $2 WHERE id = $1`, [user.id, suite.timezone]);
  user.timezone = suite.timezone;
  const conversation = await createConversation(pool, user);

  let problems: string[];
  try {
    await runTurn(
      { pool, models, now: () => now, task: suite.task },
      { user, conversationId: conversation.id, clientMessageId: randomUUID(), text: c.text, inputMode: "text", source: "chat" },
      () => {},
    );
    const rows = await pool.query(`SELECT activity, category, duration_min, started_at, metrics FROM log_entries WHERE user_id = $1`, [user.id]);
    problems = check(c.expect.entries, c.expect.forbid_activities ?? [], rows.rows, suite.timezone);
  } catch (err) {
    problems = [`turn failed: ${err instanceof Error ? err.message : String(err)}`];
  }
  if (!problems.length) passed++;
  console.log(`${problems.length ? "FAIL" : "pass"}  ${c.id}${problems.length ? `\n      ${problems.join("\n      ")}` : ""}`);
}

const rate = passed / suite.cases.length;
console.log(`\n${routes[suite.task].primary}: ${passed}/${suite.cases.length} (${Math.round(rate * 100)}%), bar ${Math.round(suite.pass_rate * 100)}%`);
await closePool();
process.exit(rate >= suite.pass_rate ? 0 : 1);
