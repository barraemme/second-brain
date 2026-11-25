/** Dense (pgvector cosine-similarity) retrieval, called directly by `GET /search`. */

import type { Kysely } from "kysely";
import { searchPassagesDense } from "../db/queries";
import type { DB, JsonObject } from "../db/types";
import { embedTexts } from "../sources/embedder";

export async function search(db: Kysely<DB>, query: string, limit: number): Promise<JsonObject[]> {
  const embedded = await embedTexts([query]);
  const [queryEmbedding] = embedded.embeddings;
  if (embedded.embeddings.length !== 1 || queryEmbedding === undefined) {
    throw new Error(`dense.search: expected 1 embedding, got ${embedded.embeddings.length}`);
  }
  return searchPassagesDense(db, queryEmbedding, limit);
}
