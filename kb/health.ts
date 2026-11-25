/** Reachability checks for `GET /health` (kb/main.ts) and `kb_health` (kb/mcp/tools.ts). */

import { sql } from "kysely";
import { settings } from "./config";
import { countActiveClaims, countArticles, countPassages } from "./db/queries";
import { getDb } from "./db/session";
import { checkMemgraphHealth, countGraphEntities } from "./graph/client";

const INNGEST_PROBE_TIMEOUT_MS = 3_000;

// Each subsystem check is isolated and broad-caught on purpose: a health
// check must report *which* dependency is down, not raise itself.

async function checkDatabase(): Promise<string> {
  try {
    await sql`SELECT 1`.execute(getDb());
    return "ok";
  } catch (error) {
    return `error: ${error}`;
  }
}

async function checkInngest(): Promise<string> {
  if (!settings.inngestDev && (!settings.inngestEventKey || !settings.inngestSigningKey)) {
    return "error: INNGEST_DEV=0 requires INNGEST_EVENT_KEY and INNGEST_SIGNING_KEY in .env";
  }
  const headers: Record<string, string> = {};
  if (settings.inngestSigningKey) headers.Authorization = `Bearer ${settings.inngestSigningKey}`;
  try {
    // Any HTTP response counts as reachable; only a network error or timeout does not.
    await fetch(settings.inngestBaseUrl, {
      headers,
      signal: AbortSignal.timeout(INNGEST_PROBE_TIMEOUT_MS),
    });
    return "ok";
  } catch (error) {
    return `error: ${error}`;
  }
}

/** Probe Postgres, Inngest and Memgraph, and count what each one holds. Read-only. */
export async function checkHealth(): Promise<Record<string, unknown>> {
  const checks: Record<string, string> = {
    database: await checkDatabase(),
    inngest: await checkInngest(),
    memgraph: await checkMemgraphHealth(),
  };

  let articles = 0;
  let passages = 0;
  let claims = 0;
  let topics = 0;
  if (checks.database === "ok") {
    const db = getDb();
    articles = await countArticles(db);
    passages = await countPassages(db);
    claims = await countActiveClaims(db);
  }
  if (checks.memgraph === "ok") {
    const [graphClaims, graphTopics] = await countGraphEntities();
    claims = Math.max(claims, graphClaims);
    topics = graphTopics;
  }

  const overallOk = Object.values(checks).every((v) => v === "ok");
  return { status: overallOk ? "ok" : "degraded", ...checks, articles, passages, claims, topics };
}
