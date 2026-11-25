/** The function list passed to the Inngest `serve(...)` handler and `connect(...)` in `kb/main.ts`. */

import { backfillPublication } from "./backfill";
import { generateWeeklyDigest } from "./digest";
import { extractClaims } from "./enrich";
import { evaluateAnswer, runEvalSuite } from "./evals";
import { pollFeeds } from "./freshness";
import { ingestArticle } from "./ingest";
import { handleFunctionFailed } from "./ops";
import { runResearchAgent } from "./research";

export const FUNCTIONS = [
  backfillPublication,
  ingestArticle,
  extractClaims,
  pollFeeds,
  handleFunctionFailed,
  evaluateAnswer,
  runEvalSuite,
  runResearchAgent,
  generateWeeklyDigest,
];
