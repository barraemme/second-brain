/**
 * Context snapshots: persist everything about one answer from `POST /ask`.
 *
 * Every candidate the retriever surfaced is stored (with its rank in each
 * engine), not only the passages the model cited. With only the cited ones you
 * cannot tell "the right passage was never retrieved" from "it was retrieved
 * and the model ignored it", and those two problems have different fixes.
 */

import type { Kysely } from "kysely";
import { saveSnapshot } from "../db/queries";
import type { DB, JsonObject } from "../db/types";
import { snapshotId } from "../schemas/ids";

/** Write one `snapshots` row and return its new `snap_...` id. */
export async function recordSnapshot(
  db: Kysely<DB>,
  options: {
    question: string;
    answerText: string;
    citations: readonly JsonObject[];
    retrieved: readonly JsonObject[];
    retrieverVariant: string;
    asOf: Date | null;
    latencyMs: number;
  },
): Promise<string> {
  const sid = snapshotId();
  await saveSnapshot(db, { ...options, snapshotId: sid });
  return sid;
}
