/**
 * Every tunable number in the pipeline lives here. Never a magic number inline.
 *
 * Each key is read from the environment variable with the same name in
 * UPPER_SNAKE_CASE (`chunkSize` <- `CHUNK_SIZE`). Bun loads `.env` on its own.
 * The type of the default decides how the raw string is parsed; a value that
 * does not parse is a startup error, never a silent fallback.
 */

const DEFAULTS = {
  // --- External services ---
  openaiApiKey: "",
  openaiApiBase: "http://127.0.0.1:8000/v1",
  databaseUrl: "postgresql://second_brain:second_brain_pw@localhost:5433/second_brain",
  inngestDev: true,
  inngestBaseUrl: "http://localhost:8288",
  inngestEventKey: "",
  inngestSigningKey: "",
  labPort: 8080,

  // --- Fetching ---
  userAgent: "second-brain/0.1",
  requestTimeoutS: 15.0,
  maxArticleBytes: 5_000_000,
  // fetchArticle follows redirects by hand so the SSRF guard checks every hop.
  maxRedirects: 5,

  // --- Chunking ---
  chunkSize: 1_000,
  chunkOverlap: 150,

  // --- Embeddings ---
  embeddingModel: "Qwen3-Embedding-0.6B-4bit-DWQ",
  embeddingDimensions: 1024,
  embeddingBatchSize: 96,
  // Verified 2026-09-19 against OpenAI's pricing page; no output-token cost for embeddings.
  embeddingPricePerMillionTokens: 0,

  // --- Discovery & backfill ---
  discoveryLimit: 5,
  publicationsFile: "publications.yaml",
  // backfill-publication sends kb/article.discovered events in batches of this size.
  backfillBatchSize: 25,

  // --- Flow control for ingest-article ---
  // How many articles from the SAME publication can be in flight at once.
  concurrencyPerPublication: 3,
  // How many ingest-article runs may START per minute, across all publications.
  // embedTexts sends a whole article in one request (up to 96 chunks), so this
  // is roughly "embedding requests per minute". Keep it under your OpenAI quota:
  // POST /ask also embeds every question.
  ingestRunsPerMinute: 50,
  // Inngest priority is a time shift in SECONDS (allowed range -600..600), not a
  // rank: a manual run is scheduled as if it had arrived 600s earlier, and a
  // backfill run as if it had arrived 600s later.
  priorityManualS: 600,
  priorityBackfillS: -600,

  // --- Retrieval & answers ---
  rrfK: 60,
  retrievalLimit: 5,
  synthesisModel: "gpt-4o-mini",
  synthesisMaxTokens: 1024,

  // --- Claim extraction & Memgraph graph ---
  memgraphUri: "bolt://localhost:7687",
  memgraphUser: "",
  memgraphPassword: "",
  extractionModel: "gpt-4o-mini",
  extractionMaxTokens: 4096,
  graphRetrievalLimit: 15,
  concurrencyExtractClaims: 2,

  // --- Evaluation suite & binary LLM judges ---
  evalJudgeModel: "gpt-4o-mini",
  evalJudgeMaxTokens: 1024,
  concurrencyEvalRuns: 2,
  evalTaxonomyFile: "evals/taxonomy.yaml",
  evalLabeledTracesFile: "evals/labeled_traces.jsonl",
  evalBenchmarkFile: "evals/golden_benchmark.yaml",
  evalMinTpr: 0.9,
  evalMinTnr: 0.9,

  // --- Bounded research agent & weekly digest ---
  researchModel: "gpt-4o-mini",
  researchMaxTokens: 2048,
  researchMaxIterations: 3,
  researchMaxSubqueriesPerHop: 3,
  researchPassagesPerHop: 5,
  researchMaxUsd: 0.25,
  concurrencyResearchRuns: 2,
  digestCron: "0 8 * * 1",
  digestLookbackDays: 7,
  digestMaxTokens: 2048,
};

export type Settings = typeof DEFAULTS;

const TRUE_WORDS = new Set(["1", "true", "yes", "on"]);
const FALSE_WORDS = new Set(["0", "false", "no", "off"]);

/** `chunkSize` -> `CHUNK_SIZE`. */
export function envName(key: string): string {
  return key.replace(/([A-Z])/g, "_$1").toUpperCase();
}

function parseValue(key: string, raw: string, fallback: string | number | boolean) {
  if (typeof fallback === "number") {
    const value = Number(raw);
    if (raw.trim() === "" || !Number.isFinite(value)) {
      throw new Error(`Setting ${envName(key)}=${JSON.stringify(raw)} is not a number`);
    }
    return value;
  }
  if (typeof fallback === "boolean") {
    const word = raw.trim().toLowerCase();
    if (TRUE_WORDS.has(word)) return true;
    if (FALSE_WORDS.has(word)) return false;
    throw new Error(`Setting ${envName(key)}=${JSON.stringify(raw)} is not a boolean`);
  }
  return raw;
}

/** Build settings from an environment map. Pure, so tests can pass their own env. */
export function loadSettings(env: Record<string, string | undefined>): Settings {
  const result: Record<string, string | number | boolean> = { ...DEFAULTS };
  for (const [key, fallback] of Object.entries(DEFAULTS)) {
    const raw = env[envName(key)];
    if (raw !== undefined) result[key] = parseValue(key, raw, fallback);
  }
  const settings = result as Settings;
  // A cron in .env is often written quoted; Inngest rejects the quotes.
  settings.digestCron = settings.digestCron.trim().replace(/^["']+|["']+$/g, "");
  if (!settings.inngestDev && settings.inngestBaseUrl.includes("localhost:8288")) {
    settings.inngestBaseUrl = "https://api.inngest.com";
  }
  return settings;
}

export const settings: Settings = loadSettings(process.env);
