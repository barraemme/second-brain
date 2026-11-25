/**
 * kb/functions/ops.ts
 *
 * Listens to inngest/function.failed system events and persists them into the
 * failures table. Captures real failures in production and staging for evaluation.
 */

import { recordFailure } from "../db/queries";
import { withTransaction } from "../db/session";
import { client } from "../inngest-client";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface FailureRecord {
  functionId: string;
  runId: string;
  error: string;
  eventData: Record<string, unknown>;
}

/** Map an `inngest/function.failed` event to a `failures` row. Pure. */
export function failureFromEvent(event: {
  name: string;
  id?: string | undefined;
  data?: unknown;
}): FailureRecord {
  const data = isRecord(event.data) ? event.data : {};
  const rawError = data.error;
  const error = isRecord(rawError) ? JSON.stringify(rawError) : String(rawError || "Unknown error");
  return {
    functionId: String(data.function_id || event.name),
    runId: String(data.run_id || event.id),
    error,
    eventData: isRecord(data.event) ? data.event : { raw: data },
  };
}

export const handleFunctionFailed = client.createFunction(
  {
    id: "handle-function-failed",
    name: "Record Function Failures",
    triggers: [{ event: "inngest/function.failed" }],
  },
  /** Capture function failures into the failures table. */
  async ({ event }) => {
    const failure = failureFromEvent(event);
    const failureId = await withTransaction((db) => recordFailure(db, failure));
    return { failure_id: String(failureId), status: "recorded" };
  },
);
