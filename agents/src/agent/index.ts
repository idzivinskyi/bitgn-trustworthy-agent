import Anthropic from "@anthropic-ai/sdk";
import { randomBytes } from "node:crypto";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TOOL_DEFS } from "./tool-defs";
import { executeCode, resetScratchpad, resetTracking, readScratchpad } from "./runtime-exec";
import { SYSTEM_PROMPT } from "./system-prompt";

// Nudge: answer not submitted — remind agent to call ws.answer()
const NUDGE_SUBMIT = `You have not submitted your answer yet. Populate scratchpad["answer"], scratchpad["outcome"], scratchpad["refs"], then define a verify(sp) function that checks your gates, and call ws.answer(scratchpad, verify). If you cannot determine the answer, use OUTCOME_NONE_CLARIFICATION.`;
import { readAnswerFile } from "../answer-file";
import type { AgentEvent, AgentResult, RunAgentOptions } from "../agent-types";

export type { AgentEvent, AgentResult, RunAgentOptions } from "../agent-types";
export type { SubmitAnswerPayload } from "../agent-types";

const MAX_NUDGES = 3;

export async function* runAgent({
  apiKey,
  model,
  taskSystemPrompt,
  taskInstruction,
  harnessUrl = "",
  workspaceTree,
  workspaceContext,
  initialMessages,
  maxIterations = 50,
  maxTokens = 16384,
  systemPromptOverride,
  skipNudges,
  logger,
}: RunAgentOptions): AsyncGenerator<AgentEvent, AgentResult> {

  // Unique per-task paths — required for concurrent execution
  const suffix = randomBytes(8).toString("hex");
  const scratchpadPath = join(tmpdir(), `agent-scratchpad-${suffix}.json`);
  const statePath = join(tmpdir(), `agent-state-${suffix}.json`);
  const answerPath = join(tmpdir(), `agent-answer-${suffix}.json`);
  const trackingPath = join(tmpdir(), `agent-tracking-${suffix}.json`);

  try {
  const scratchpadSeed = workspaceContext
    ? { context: JSON.parse(workspaceContext), refs: [] }
    : { refs: [] };
  await resetScratchpad(scratchpadPath, scratchpadSeed);
  await resetTracking(trackingPath);

  const client = new Anthropic({
    apiKey,
    defaultHeaders: { "anthropic-beta": "compact-2026-01-12" },
  });

  const tools = TOOL_DEFS.map((t, i) =>
    i === TOOL_DEFS.length - 1 ? { ...t, cache_control: { type: "ephemeral" as const } } : t,
  );

  const firstMessage = taskInstruction;

  const messages: Anthropic.MessageParam[] = initialMessages
    ? [...initialMessages, { role: "user" as const, content: firstMessage }]
    : [{ role: "user" as const, content: firstMessage }];

  let totalIn = 0;
  let totalOut = 0;
  let iterations = 0;
  let answer = null;
  let remainingIter = maxIterations;

  const maxAttempts = skipNudges ? 0 : MAX_NUDGES;
  for (let attempt = 0; attempt <= maxAttempts; attempt++) {
    for (let iter = 0; iter < remainingIter; iter++) {
      iterations++;
      logger?.debug({ iteration: iterations - 1 }, 'agent iteration');

      const scratchpadData = await readScratchpad(scratchpadPath);

      yield { kind: "scratchpad", scratchpad: scratchpadData ?? {} };

      // System prompt: use override if provided, else default SYSTEM_PROMPT
      const baseSystemPrompt = systemPromptOverride ?? SYSTEM_PROMPT;

      // Task system prompt from the benchmark description
      const taskSystemPromptText = `<task-system-prompt>\n${taskSystemPrompt}\n</task-system-prompt>`;

      const systemBlocks: Array<{ type: "text"; text: string; cache_control?: { type: "ephemeral" } }> = [];

      systemBlocks.push(
        { type: "text", text: baseSystemPrompt, cache_control: { type: "ephemeral" } },
        { type: "text", text: taskSystemPromptText, cache_control: { type: "ephemeral" } },
      );

      if (workspaceTree) {
        systemBlocks.push({ type: "text", text: `<workspace-tree>\n${workspaceTree}\n</workspace-tree>`, cache_control: { type: "ephemeral" } });
      }

      let scratchpadText: string;
      if (scratchpadData && Object.keys(scratchpadData).length > 0) {
        scratchpadText = `<scratchpad>\n${JSON.stringify(scratchpadData, null, 2)}\n</scratchpad>`;
      } else if (iterations >= 4) {
        scratchpadText = `<scratchpad>EMPTY — you must populate scratchpad with your findings and verification. Before finishing, set scratchpad["answer"], scratchpad["outcome"], scratchpad["refs"], and scratchpad["verification"].</scratchpad>`;
      } else {
        scratchpadText = `<scratchpad>no info</scratchpad>`;
      }

      if (iterations >= maxIterations * 0.8) {
        const left = maxIterations - iterations;
        scratchpadText += `\n<budget-warning>${left} iterations remaining — finalize your answer and call ws.answer() now.</budget-warning>`;
      }

      systemBlocks.push({ type: "text", text: scratchpadText });

      const callStart = Date.now();
      const response = await client.messages.create({
        model,
        max_tokens: maxTokens,
        system: systemBlocks,
        messages,
        tools,
        thinking: { type: "adaptive" as const },
        output_config: { effort: "medium" as const },
        context_management: {
          edits: [{
            type: "compact_20260112",
            trigger: { type: "input_tokens", value: 150000 },
          }],
        },
      } as Anthropic.MessageCreateParamsNonStreaming);
      const durationMs = Date.now() - callStart;

      if (response.stop_reason === "max_tokens") {
        logger?.warn(
          { iteration: iterations - 1, maxTokens, outputTokens: response.usage.output_tokens },
          "TRUNCATED: response hit max_tokens ceiling"
        );
      }

      const inputTokens = response.usage.input_tokens;
      const outputTokens = response.usage.output_tokens;
      const cacheRead = response.usage.cache_read_input_tokens ?? 0;
      const cacheCreate = response.usage.cache_creation_input_tokens ?? 0;

      totalIn += inputTokens;
      totalOut += outputTokens;

      logger?.debug({ inputTokens, outputTokens, cacheRead, cacheCreate, durationMs }, 'api call');

      yield {
        kind: "api_call", iteration: iterations - 1,
        inputTokens,
        outputTokens,
        cacheReadTokens: cacheRead,
        cacheCreateTokens: cacheCreate,
        durationMs,
      };

      messages.push({ role: "assistant", content: response.content });

      for (const block of response.content) {
        if (block.type === "text") yield { kind: "text", text: block.text };
        // thinking blocks are skipped silently
      }

      const toolUses = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
      );
      if (toolUses.length === 0) {
        break;
      }

      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const tu of toolUses) {
        const input = tu.input as Record<string, unknown>;

        // Handle API-level compaction tool call (beta: compact-2026-01-12)
        if (tu.type === "tool_use" && tu.name === "compact_20260112") {
          yield { kind: "compaction", fromMessages: messages.length, toMessages: messages.length };
          toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: "" });
          continue;
        }

        logger?.info({ tool: tu.name, inputLength: JSON.stringify(input).length }, 'tool call');
        yield { kind: "tool_call", name: tu.name, input };

        let result: { content: string; is_error?: boolean };

        if (tu.name === "execute_code") {
          const code = typeof input.code === "string" ? input.code : "";
          result = await executeCode(code, harnessUrl, scratchpadPath, statePath, answerPath, trackingPath);
        } else {
          result = { content: `Unknown tool: ${tu.name}`, is_error: true };
        }

        toolResults.push({ type: "tool_result", tool_use_id: tu.id, ...result });
        yield { kind: "tool_result", name: tu.name, result: result.content, isError: result.is_error ?? false };
      }

      messages.push({ role: "user", content: toolResults });

      // Check if answer was submitted via ws.answer()
      answer = await readAnswerFile(answerPath, false);
      if (answer) {
        const outcome = answer.outcome ?? "no_answer";
        logger?.info({ iterations, totalIn, totalOut, outcome }, 'agent complete');
        return { answer, totalInputTokens: totalIn, totalOutputTokens: totalOut, iterations, messages };
      }
    }

    // After inner loop: check answer file first
    answer = await readAnswerFile(answerPath, false);
    if (answer) break;

    // Single nudge: answer not submitted
    logger?.info({ attempt, iterations }, "no answer submitted — nudging to submit");
    messages.push({ role: "user", content: NUDGE_SUBMIT });
    remainingIter = 3;
  }

  if (answer) {
    logger?.info({ iterations, totalIn, totalOut, outcome: answer.outcome }, 'agent complete');
    return { answer, totalInputTokens: totalIn, totalOutputTokens: totalOut, iterations, messages };
  }

  logger?.warn({ iterations, totalIn, totalOut }, 'agent finished without submitting answer');
  return { answer: null, totalInputTokens: totalIn, totalOutputTokens: totalOut, iterations, messages };
  } finally {
    await Promise.all([
      unlink(scratchpadPath).catch(() => {}),
      unlink(statePath).catch(() => {}),
      unlink(answerPath).catch(() => {}),
      unlink(trackingPath).catch(() => {}),
    ]);
  }
}
