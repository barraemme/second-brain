import { describe, expect, test } from "bun:test";
import { envName, loadSettings } from "../../kb/config";
import { toPgUrl } from "../../kb/db/session";
import { usageFromOutput } from "../../kb/inngest-client";

describe("loadSettings", () => {
  test("env names are the keys in UPPER_SNAKE_CASE", () => {
    expect(envName("chunkSize")).toBe("CHUNK_SIZE");
    expect(envName("openaiApiBase")).toBe("OPENAI_API_BASE");
  });

  test("defaults apply when the environment is empty", () => {
    const settings = loadSettings({});
    expect(settings.chunkSize).toBe(1000);
    expect(settings.inngestDev).toBe(true);
  });

  test("numbers and booleans are parsed from strings", () => {
    const settings = loadSettings({ CHUNK_SIZE: "500", INNGEST_DEV: "0", EVAL_MIN_TPR: "0.8" });
    expect(settings.chunkSize).toBe(500);
    expect(settings.inngestDev).toBe(false);
    expect(settings.evalMinTpr).toBe(0.8);
  });

  test("a value that does not parse fails loudly", () => {
    expect(() => loadSettings({ CHUNK_SIZE: "big" })).toThrow("CHUNK_SIZE");
    expect(() => loadSettings({ INNGEST_DEV: "maybe" })).toThrow("INNGEST_DEV");
    expect(() => loadSettings({ CHUNK_SIZE: "" })).toThrow("CHUNK_SIZE");
  });

  test("quotes around the digest cron are stripped", () => {
    expect(loadSettings({ DIGEST_CRON: "'0 8 * * 1'" }).digestCron).toBe("0 8 * * 1");
  });

  test("cloud mode never points at the local dev server", () => {
    const settings = loadSettings({ INNGEST_DEV: "false" });
    expect(settings.inngestBaseUrl).toBe("https://api.inngest.com");
  });
});

describe("toPgUrl", () => {
  test("drops the Python driver suffix from old .env files", () => {
    expect(toPgUrl("postgresql+asyncpg://u:p@h:5433/db")).toBe("postgresql://u:p@h:5433/db");
    expect(toPgUrl("postgresql://u:p@h/db")).toBe("postgresql://u:p@h/db");
  });
});

describe("usageFromOutput", () => {
  test("finds a complete usage record", () => {
    const usage = { model: "m", input_tokens: 1, output_tokens: 2, est_usd: 0.1 };
    expect(usageFromOutput({ usage, other: 1 })).toEqual(usage);
  });

  test("ignores outputs without a complete usage record", () => {
    expect(usageFromOutput(null)).toBeNull();
    expect(usageFromOutput([1, 2])).toBeNull();
    expect(usageFromOutput({ usage: { model: "m" } })).toBeNull();
  });
});
