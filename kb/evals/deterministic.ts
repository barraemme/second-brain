/**
 * Level 1 deterministic code evaluators.
 *
 * Following Hamel Husain's evaluation hierarchy, structural, referential, and
 * temporal validity checks are executed in deterministic code first, at 0 USD
 * cost and <1ms latency, before any LLM-as-a-judge is invoked.
 */

/** One retrieved passage or citation (snake_case keys, as stored and sent on the wire). */
export type Row = Record<string, unknown>;

const INLINE_CITATION_RE = /\[(\d+)\]/g;
const ABSTAIN_PHRASES = [
  "no relevant passages were found",
  "coverage of this topic is limited",
  // Never matches (the answer is lowercased first); kept verbatim from the Python version.
  "set OPENAI_API_KEY to get an answer",
] as const;

export interface DeterministicEvalResult {
  passed: boolean;
  checks: Record<string, boolean>;
  failure_codes: string[];
  score: number;
}

export interface DeterministicCheckOptions {
  answerText: string;
  citations: Row[];
  retrieved: Row[];
  promptLimit?: number;
}

/** Python's `round(value, digits)` for the metric scores. Pure. */
export function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Return all unique integer indices `[k]` appearing in `answerText` in order. */
export function extractInlineCitationIndices(answerText: string): number[] {
  const indices: number[] = [];
  for (const match of answerText.matchAll(INLINE_CITATION_RE)) {
    const idx = Number(match[1]);
    if (!indices.includes(idx)) indices.push(idx);
  }
  return indices;
}

export function isAbstainAnswer(answerText: string): boolean {
  const lower = answerText.toLowerCase();
  return ABSTAIN_PHRASES.some((phrase) => lower.includes(phrase));
}

/** Check 1: `citation_bounds_valid` (FM-1). */
function citationBoundsValid(
  inlineIndices: number[],
  citations: Row[],
  retrieved: Row[],
  promptLimit: number,
): boolean {
  if (retrieved.length === 0 && inlineIndices.length > 0) return false;
  const maxValidIdx = Math.min(retrieved.length, promptLimit);
  const citedIdx = new Set(
    citations.filter((c) => "citation_idx" in c).map((c) => Number(c.citation_idx)),
  );
  return inlineIndices.every((idx) => idx >= 1 && idx <= maxValidIdx && citedIdx.has(idx));
}

/** Check 3: `no_superseded_sources_cited` (FM-2). */
function noSupersededSourcesCited(citations: Row[], retrievedByPid: Map<string, Row>): boolean {
  return citations.every((c) => {
    if (c.valid_to != null) return false;
    const retRow = retrievedByPid.get(String(c.passage_id ?? ""));
    return retRow === undefined || retRow.valid_to == null;
  });
}

/** Check 4: `abstain_or_cite_discipline` (FM-3). */
function abstainOrCiteDiscipline(
  answerText: string,
  inlineIndices: number[],
  citations: Row[],
  retrieved: Row[],
): boolean {
  const abstain = isAbstainAnswer(answerText);
  if (retrieved.length === 0)
    return abstain && inlineIndices.length === 0 && citations.length === 0;
  return abstain || (inlineIndices.length >= 1 && citations.length >= 1);
}

/**
 * Run all four deterministic assertions on a snapshot (`FM-1`, `FM-2`, `FM-3`):
 *
 * 1. `citation_bounds_valid` (FM-1): Every inline `[k]` is within
 *    `1..len(retrieved[:promptLimit])` and has a matching entry in `citations`.
 * 2. `citations_subset_of_retrieved` (FM-1): Every `passage_id` in `citations`
 *    exists in `retrieved`.
 * 3. `no_superseded_sources_cited` (FM-2): No cited passage or claim has `valid_to` set.
 * 4. `abstain_or_cite_discipline` (FM-3):
 *    - If `retrieved` is empty, `answerText` must abstain and have zero citations.
 *    - If `retrieved` is non-empty and `answerText` is not an abstain message, it must
 *      include at least one inline citation `[k]`.
 */
export function runDeterministicChecks(
  options: DeterministicCheckOptions,
): DeterministicEvalResult {
  const { answerText, citations, retrieved, promptLimit = 5 } = options;
  if (promptLimit < 0)
    throw new Error(`runDeterministicChecks: negative promptLimit ${promptLimit}`);
  const inlineIndices = extractInlineCitationIndices(answerText);
  const retrievedByPid = new Map(
    retrieved.filter((r) => "passage_id" in r).map((r) => [String(r.passage_id), r] as const),
  );

  const boundsOk = citationBoundsValid(inlineIndices, citations, retrieved, promptLimit);
  const subsetOk = citations.every((c) => retrievedByPid.has(String(c.passage_id ?? "")));
  const freshnessOk = noSupersededSourcesCited(citations, retrievedByPid);
  const disciplineOk = abstainOrCiteDiscipline(answerText, inlineIndices, citations, retrieved);

  const checks: Record<string, boolean> = {
    citation_bounds_valid: boundsOk,
    citations_subset_of_retrieved: subsetOk,
    no_superseded_sources_cited: freshnessOk,
    abstain_or_cite_discipline: disciplineOk,
  };

  const failureCodes: string[] = [];
  if (!boundsOk || !subsetOk) failureCodes.push("FM-1");
  if (!freshnessOk) failureCodes.push("FM-2");
  if (!disciplineOk) failureCodes.push("FM-3");

  const values = Object.values(checks);
  const passedCount = values.filter(Boolean).length;
  return {
    passed: passedCount === values.length,
    checks,
    failure_codes: failureCodes,
    score: roundTo(passedCount / values.length, 4),
  };
}
