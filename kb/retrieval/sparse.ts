/** Sparse (BM25) retrieval, called directly by `GET /search`. */

import type { Kysely } from "kysely";
import { searchPassagesBm25 } from "../db/queries";
import type { DB, JsonObject } from "../db/types";

export async function search(db: Kysely<DB>, query: string, limit: number): Promise<JsonObject[]> {
  return searchPassagesBm25(db, query, limit);
}
