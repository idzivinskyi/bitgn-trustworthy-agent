import type Anthropic from "@anthropic-ai/sdk";
import { Command } from "commander";
import { createConnectClient } from "./connectrpc-client";
import { HarnessService } from "@buf/bitgn_api.bufbuild_es/bitgn/harness_pb";
import { PcmRuntime, Outcome } from "@buf/bitgn_api.bufbuild_es/bitgn/vm/pcm_pb";
import { runAgent } from "./agent/index";
import { SYSTEM_PROMPT } from "./agent/system-prompt";
import { loadConfig } from "./config";
import { createLogger, logEvent } from "./utils/logger";
import { calculateCost, formatCost } from "./utils/cost";

// ── Concurrency utility ───────────────────────────────────────────────────

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift()!;
      await fn(item);
    }
  });
  await Promise.all(workers);
}

// ── Config ─────────────────────────────────────────────────────────────────

const config = loadConfig();

// ── CLI ────────────────────────────────────────────────────────────────────

const program = new Command()
  .name("bitgn-agents")
  .description("Run PAC1 benchmark tasks with Anthropic agent")
  .option("--api-key <key>", "Anthropic API key", config.apiKey)
  .option("--bitgn-api-key <key>", "BitGN platform API key (enables leaderboard runs)", config.bitgnApiKey)
  .option("--model <id>", "model to use", config.modelId)
  .option("--host <url>", "BitGN platform URL", config.benchmarkHost)
  .option("--benchmark <id>", "benchmark identifier", config.benchmarkId)
  .option(
    "--max-iterations <n>",
    "max agent iterations per task",
    (v: string) => parseInt(v, 10),
    config.maxIterations,
  )
  .option(
    "--max-tokens <n>",
    "max tokens per API response",
    (v: string) => parseInt(v, 10),
    config.maxTokens,
  )
  .option("--concurrency <n>", "parallel task concurrency", (v: string) => parseInt(v, 10), 1)
  .option("--submit", "submit run to leaderboard (requires BITGN_API_KEY)", false)
  .option(
    "--log-level <level>",
    "log level (trace/debug/info/warn/error/silent)",
    config.logLevel,
  )
  .argument("[tasks...]", "task IDs to run (substring match)")
  .parse();

const opts = program.opts<{
  apiKey?: string;
  bitgnApiKey?: string;
  model: string;
  host: string;
  benchmark: string;
  maxIterations: number;
  maxTokens: number;
  concurrency: number;
  submit: boolean;
  logLevel: string;
}>();
const taskFilter: string[] = program.args;

// ── Run name generator ────────────────────────────────────────────────────

const RUN_NAME = "Operation Pangolin";

// ── Helpers ────────────────────────────────────────────────────────────────

function formatTokens(s: { inputTokens: number; outputTokens: number; cacheTokens: number }): string {
  return `${(s.inputTokens / 1000).toFixed(0)}k in, ${(s.outputTokens / 1000).toFixed(0)}k out, ${(s.cacheTokens / 1000).toFixed(0)}k cached`;
}

function shortOutcome(outcome: string): string {
  return outcome.replace(/^OUTCOME_/, "");
}


// ── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Prevent EventEmitter warnings when many concurrent agents add exit listeners
  process.setMaxListeners(Math.max(process.getMaxListeners(), opts.concurrency + 10));

  const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("No Anthropic credentials found. Set ANTHROPIC_API_KEY.");

  // Logger
  const logger = createLogger(opts.logLevel ?? config.logLevel, "bitgn");

  console.log(`Model:      ${opts.model}`);
  console.log(`Benchmark:  ${opts.benchmark}`);
  console.log(`Host:       ${opts.host}`);
  console.log(`Concurrency: ${opts.concurrency}`);
  console.log();

  const harness = createConnectClient(HarnessService, opts.host);

  const status = await harness.status({});
  console.log(`Harness status: ${status.status} (${status.version})`);

  const bench = await harness.getBenchmark({ benchmarkId: opts.benchmark });
  const isBlindMode = bench.policy === 1; // EvalPolicy.BLIND
  console.log(`Benchmark: ${bench.benchmarkId} — ${bench.tasks.length} tasks`);
  console.log(`Eval mode: ${isBlindMode ? "blind (scores hidden)" : "open"}`);
  console.log();

  const tasks =
    taskFilter.length > 0
      ? bench.tasks.filter((t: { taskId: string }) =>
        taskFilter.some((f) => t.taskId.includes(f)),
      )
      : bench.tasks;

  if (tasks.length === 0) {
    console.log("No matching tasks found.");
    return;
  }

  type ScoreEntry = {
    taskId: string;
    score: number | null;
    outcome: string;
    iterations: number;
    inputTokens: number;
    outputTokens: number;
    cacheTokens: number;
    cacheCreateTokens: number;
    cacheHitRate: number;
    durationSec: number;
    status: string;
  };
  let scores: ScoreEntry[] = [];

  let currentSystemPrompt = SYSTEM_PROMPT;

  // ── Run mode (leaderboard) vs playground mode ──────────────────────────
  const useRunMode = opts.submit;
  let activeRunId: string | undefined;
  let trialIdMap = new Map<string, string>(); // taskId → trialId

  if (useRunMode) {
    const runName = RUN_NAME;
    console.log(`Run mode: ${runName}${opts.bitgnApiKey ? " (with API key)" : ""}`);
    const run = await harness.startRun({
      benchmarkId: opts.benchmark,
      name: runName,
      ...(opts.bitgnApiKey ? { apiKey: opts.bitgnApiKey } : {}),
    });
    activeRunId = run.runId;
    console.log(`Run ID: ${run.runId} (${run.trialIds.length} trials)`);

    // Map trialIds to tasks — startTrial returns taskId
    for (const trialId of run.trialIds) {
      const trial = await harness.startTrial({ trialId });
      trialIdMap.set(trial.taskId, trial.trialId);
    }
  }

  // ── Iteration runner ─────────────────────────────────────────────────
  async function runIteration(iterLabel: string): Promise<number> {
    scores = [];
    const iterStartMs = Date.now();

    async function runOneTask(task: (typeof tasks)[0]): Promise<void> {
      const pfx = opts.concurrency > 1 ? `[${task.taskId}] ` : "  ";
      const lines: string[] = [];
      const write = (msg: string) => lines.push(msg);

      write(`--- Task: ${task.taskId} ---`);

      // Run mode: use pre-created trial. Playground mode: create on-demand.
      const trial = useRunMode
        ? await harness.startTrial({ trialId: trialIdMap.get(task.taskId)! })
        : await harness.startPlayground({ benchmarkId: opts.benchmark, taskId: task.taskId });
      write(`${pfx}Trial: ${trial.trialId}`);
      write(
        `${pfx}Instruction: ${trial.instruction}`,
      );

      const rs = createConnectClient(PcmRuntime, trial.harnessUrl);

      let taskStatus: "completed" | "error" = "completed";
      let taskOutcome = "no_answer";
      let iterations = 0;
      let totalCacheRead = 0;
      let totalCacheCreate = 0;
      let totalInputTokens = 0;
      let totalOutputTokens = 0;
      const taskStartMs = Date.now();

      try {
        logger.debug({ maxIterations: opts.maxIterations, maxTokens: opts.maxTokens, model: opts.model }, "runAgent params");

        let workspaceTree: string | undefined;
        let workspaceContext: string | undefined;
        const protoReplacer = (k: string, v: unknown) => {
          if (k === "$typeName") return undefined;
          return typeof v === "bigint" ? v.toString() : v;
        };
        try {
          const [tree, ctx] = await Promise.all([
            rs.tree({ root: "", level: 2 }),
            rs.context({}),
          ]);
          workspaceTree = JSON.stringify(tree, protoReplacer, 2);
          workspaceContext = JSON.stringify(ctx, protoReplacer);
        } catch (e) { logger.debug({ err: e }, "workspace pre-fetch failed"); }

        const gen = runAgent({
          apiKey: apiKey!,
          model: opts.model,
          taskSystemPrompt: bench.description,
          taskInstruction: trial.instruction,
          harnessUrl: trial.harnessUrl,
          workspaceTree,
          workspaceContext,
          maxIterations: opts.maxIterations,
          maxTokens: opts.maxTokens,
          systemPromptOverride: currentSystemPrompt,
          logger,
        });

        let next = await gen.next();
        while (!next.done) {
          const event = next.value;
          if (event.kind === "api_call") {
            totalCacheRead += event.cacheReadTokens;
            totalCacheCreate += event.cacheCreateTokens;
          }
          logEvent(event, pfx, write);
          next = await gen.next();
        }

        const result = next.value;
        iterations = result.iterations;
        totalInputTokens = result.totalInputTokens;
        totalOutputTokens = result.totalOutputTokens;
        taskOutcome = result.answer?.outcome ?? "no_answer";

        write(
          `${pfx}Completed: ${result.iterations} iterations, ` +
          `${result.totalInputTokens} in / ${result.totalOutputTokens} out tokens`,
        );

        if (result.answer) {
          write(`${pfx}Answer submitted: ${result.answer.message}`);
        } else {
          write(`${pfx}No answer produced — submitting fallback.`);
          taskStatus = "error";
          try {
            await rs.answer({ message: "Agent did not produce an answer.", outcome: Outcome.ERR_INTERNAL, refs: [] });
          } catch (err) {
            write(
              `${pfx}ERROR: Failed to submit fallback: ${err instanceof Error ? err.message : err}`,
            );
          }
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const stderr = err instanceof Error && "stderr" in err ? ` | stderr: ${(err as any).stderr}` : "";
        write(`${pfx}ERROR: Agent error: ${errMsg}${stderr}`);
        taskStatus = "error";
        taskOutcome = "error";
        try {
          await rs.answer({
            message: `Agent error: ${err instanceof Error ? err.message : String(err)}`,
            outcome: Outcome.ERR_INTERNAL,
            refs: [],
          });
        } catch (submitErr) {
          write(`${pfx}ERROR: Failed to submit error fallback: ${submitErr instanceof Error ? submitErr.message : submitErr}`);
        }
      }

      let score: number | null = null;
      let scoreDetail: string[] = [];
      try {
        const endResult = await harness.endTrial({ trialId: trial.trialId });
        score = endResult.score ?? null;
        scoreDetail = endResult.scoreDetail ?? [];
        if (scoreDetail.length > 0) {
          write(`${pfx}Eval: ${scoreDetail.join("; ")}`);
        }
      } catch (err) {
        write(`${pfx}ERROR: Failed to end trial: ${err instanceof Error ? err.message : err}`);
      }

      const cacheTotal = totalCacheRead + totalCacheCreate;
      const cacheHitRate = cacheTotal > 0 ? totalCacheRead / cacheTotal : 0;
      const durationMs = Date.now() - taskStartMs;
      const durationSec = Math.round(durationMs / 1000);

      scores.push({ taskId: task.taskId, score, outcome: taskOutcome, iterations, inputTokens: totalInputTokens, outputTokens: totalOutputTokens, cacheTokens: totalCacheRead, cacheCreateTokens: totalCacheCreate, cacheHitRate, durationSec, status: taskStatus });

      const scoreStr = score !== null ? `${(score * 100).toFixed(1)}%` : "N/A";
      write(`  [${task.taskId}] Score: ${scoreStr} ${shortOutcome(taskOutcome)} (${iterations} iter, ${durationSec}s)`);

      // Flush all buffered output as a single block
      console.log(lines.join("\n"));
    }

    await runWithConcurrency(tasks, opts.concurrency, runOneTask);

    if (useRunMode && activeRunId) {
      try {
        const result = await harness.submitRun({ runId: activeRunId, force: true });
        console.log(`\n  Run submitted: ${result.runId}`);
      } catch (err) {
        console.log(`  ERROR: Failed to submit run: ${err instanceof Error ? err.message : err}`);
      }
    }

    // Full scoreboard after all tasks complete
    console.log(`  ┌─── Scoreboard (${scores.length}/${tasks.length} tasks) ───`);
    for (const s of scores) {
      const sScoreStr = s.score !== null ? (s.score * 100).toFixed(1) + "%" : "N/A";
      const icon = s.score === 1 ? "✓" : s.score === 0 ? "✗" : "·";
      const tk = formatTokens(s);
      const cost = formatCost(calculateCost(opts.model, s.inputTokens, s.outputTokens, s.cacheTokens, s.cacheCreateTokens));
      console.log(
        `  │ ${icon} ${s.taskId}: ${sScoreStr} ${shortOutcome(s.outcome)} (${s.iterations} iter, ${s.durationSec}s, ${tk}, ${cost})`,
      );
    }
    const validSoFar = scores.filter((s) => s.score !== null).map((s) => s.score!);
    if (validSoFar.length > 0) {
      const avg = validSoFar.reduce((a, b) => a + b, 0) / validSoFar.length;
      console.log(`  │ avg: ${(avg * 100).toFixed(1)}% (${validSoFar.length} scored)`);
    }
    console.log(`  └────────────────────────`);
    console.log();

    console.log("--- Summary ---");
    scores.sort((a, b) => a.taskId.localeCompare(b.taskId, undefined, { numeric: true }));
    for (const s of scores) {
      const scoreStr = s.score !== null ? (s.score * 100).toFixed(1) + "%" : "N/A";
      const tk = formatTokens(s);
      const cost = formatCost(calculateCost(opts.model, s.inputTokens, s.outputTokens, s.cacheTokens, s.cacheCreateTokens));
      console.log(
        `  ${s.taskId}: ${scoreStr} ${shortOutcome(s.outcome)} (${s.iterations} iter, ${s.durationSec}s, ${tk}, ${cost}, ${s.status})`,
      );
    }

    const totalInput = scores.reduce((a, s) => a + s.inputTokens, 0);
    const totalOutput = scores.reduce((a, s) => a + s.outputTokens, 0);
    const totalCache = scores.reduce((a, s) => a + s.cacheTokens, 0);
    const totalCacheCreateAll = scores.reduce((a, s) => a + s.cacheCreateTokens, 0);
    const totalTime = scores.reduce((a, s) => a + s.durationSec, 0);
    const totalCost = calculateCost(opts.model, totalInput, totalOutput, totalCache, totalCacheCreateAll);
    const validScores = scores.filter((s) => s.score !== null).map((s) => s.score!);
    if (validScores.length > 0) {
      const avg = validScores.reduce((a, b) => a + b, 0) / validScores.length;
      console.log(`\n  Average: ${(avg * 100).toFixed(1)}% (${validScores.length}/${scores.length} scored)`);
    }
    const wallSec = Math.round((Date.now() - iterStartMs) / 1000);
    console.log(`  Total: ${(totalInput / 1000).toFixed(0)}k in, ${(totalOutput / 1000).toFixed(0)}k out, ${(totalCache / 1000).toFixed(0)}k cached, ${totalTime}s, ${formatCost(totalCost)}, wall ${wallSec}s`);

    const validScoresIter = scores.filter((s) => s.score !== null).map((s) => s.score!);
    return validScoresIter.length > 0
      ? validScoresIter.reduce((a, b) => a + b, 0) / validScoresIter.length
      : 0;
  } // end runIteration

  await runIteration("initial");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
