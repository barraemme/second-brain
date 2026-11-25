/**
 * Deterministic chunking: pure function, unit-tested separately from the pipeline.
 *
 * Splits on whitespace (never mid-word) into chunks of at most `chunkSize`
 * characters, with roughly `chunkOverlap` characters repeated between
 * consecutive chunks so an idea spanning a chunk boundary isn't lost entirely
 * to one side.
 */

/** Index one past the last word of the chunk that starts at `start`. Always > start. */
function chunkEnd(words: readonly string[], start: number, chunkSize: number): number {
  let length = 0;
  let end = start;
  while (end < words.length) {
    const added = (words[end]?.length ?? 0) + (end > start ? 1 : 0);
    if (end > start && length + added > chunkSize) break;
    length += added;
    end += 1;
  }
  // A single word longer than chunkSize still gets its own chunk (end = start + 1).
  return end;
}

/** Start of the next chunk: step back from `end` by roughly `chunkOverlap` characters. */
function overlapStart(
  words: readonly string[],
  start: number,
  end: number,
  chunkOverlap: number,
): number {
  let overlapLen = 0;
  let j = end - 1;
  while (j >= start && overlapLen < chunkOverlap) {
    overlapLen += (words[j]?.length ?? 0) + 1;
    j -= 1;
  }
  // Always move forward, so the outer loop terminates.
  return Math.max(j + 1, start + 1);
}

export function chunkText(
  text: string,
  options: { chunkSize: number; chunkOverlap: number },
): string[] {
  const { chunkSize, chunkOverlap } = options;
  if (chunkOverlap >= chunkSize) throw new Error("chunk_overlap must be smaller than chunk_size");

  const words = text.split(/\s+/).filter(Boolean);
  const chunks: string[] = [];
  let start = 0;
  // Each pass advances `start` by at least one word, so words.length passes is the ceiling.
  for (let pass = 0; pass < words.length && start < words.length; pass++) {
    const end = chunkEnd(words, start, chunkSize);
    chunks.push(words.slice(start, end).join(" "));
    if (end >= words.length) return chunks;
    start = overlapStart(words, start, end, chunkOverlap);
  }
  if (start < words.length) throw new Error("chunkText: did not reach the end of the text");
  return chunks;
}
