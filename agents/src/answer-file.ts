import { readFile, unlink } from "node:fs/promises";
import type { SubmitAnswerPayload } from "./agent-types";

export async function readAnswerFile(path: string, cleanup = true): Promise<SubmitAnswerPayload | null> {
  try {
    const raw = await readFile(path, "utf-8");
    const data = JSON.parse(raw);
    return {
      message: typeof data.message === "string" ? data.message : "",
      outcome: typeof data.outcome === "string" ? data.outcome : "OUTCOME_OK",
      refs: Array.isArray(data.refs) ? data.refs.filter((r: unknown): r is string => typeof r === "string") : [],
    };
  } catch {
    return null;
  } finally {
    if (cleanup) await unlink(path).catch(() => {});
  }
}
