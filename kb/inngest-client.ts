/**
 * The Inngest client, plus middleware that captures LLM/embedding cost.
 *
 * Any step that calls an LLM or embedding provider (e.g. `kb/sources/embedder.ts`)
 * returns a JSON-serializable object with a top-level `usage` key shaped like
 * `{ model, input_tokens, output_tokens, est_usd }`. `CostCaptureMiddleware`
 * recognizes that shape in `onStepComplete` and writes one row to `costs`,
 * without every call site needing to touch the database itself.
 *
 * Why this doesn't double-count on replay: `onStepComplete` is never called
 * for memoized step outputs, only for a step whose callable really ran. A
 * genuine retry of a failed step re-runs the callable (and the underlying LLM
 * call) for real, so recording its cost again is correct, not a bug.
 */

import { Inngest, Middleware } from "inngest";
import { settings } from "./config";
import { insertCost } from "./db/queries";
import { withTransaction } from "./db/session";

export interface UsageRecord {
  model: string;
  input_tokens: number;
  output_tokens: number;
  est_usd: number;
  article_id?: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The `usage` record of a step output, or null when the output carries none. Pure. */
export function usageFromOutput(output: unknown): UsageRecord | null {
  if (!isRecord(output)) return null;
  const usage = output.usage;
  if (!isRecord(usage)) return null;
  const hasAllKeys = ["model", "input_tokens", "output_tokens", "est_usd"].every(
    (key) => key in usage,
  );
  return hasAllKeys ? (usage as unknown as UsageRecord) : null;
}

class CostCaptureMiddleware extends Middleware.BaseMiddleware {
  readonly id = "cost-capture";

  override async onStepComplete({ output }: Middleware.OnStepCompleteArgs): Promise<void> {
    const usage = usageFromOutput(output);
    if (usage === null) return;
    await withTransaction((db) =>
      insertCost(db, {
        model: usage.model,
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        estUsd: usage.est_usd,
        articleId: usage.article_id ?? null,
      }),
    );
  }
}

export const client = new Inngest({
  id: "substack-brain",
  isDev: settings.inngestDev,
  ...(settings.inngestDev ? { baseUrl: settings.inngestBaseUrl } : {}),
  ...(settings.inngestEventKey ? { eventKey: settings.inngestEventKey } : {}),
  middleware: [CostCaptureMiddleware],
});
