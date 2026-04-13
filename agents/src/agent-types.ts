import type Anthropic from "@anthropic-ai/sdk";

// ── Events yielded during agent execution ────────────────────────────────

export type AgentEvent =
  | { kind: "text"; text: string }
  | { kind: "tool_call"; name: string; input: Record<string, unknown> }
  | { kind: "tool_result"; name: string; result: string; isError: boolean }
  | { kind: "api_call"; iteration: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreateTokens: number; durationMs: number }
  | { kind: "scratchpad"; scratchpad: Record<string, unknown> }
  | { kind: "compaction"; fromMessages: number; toMessages: number };

// ── Final result returned by agent ───────────────────────────────────────

export interface SubmitAnswerPayload {
  message: string;
  outcome: string;
  refs: string[];
}

export interface AgentResult {
  answer: SubmitAnswerPayload | null;
  totalInputTokens: number;
  totalOutputTokens: number;
  iterations: number;
  messages: Anthropic.MessageParam[];
}

// ── Options passed to any agent runner ───────────────────────────────────

export interface RunAgentOptions {
  apiKey: string;
  model: string;
  taskSystemPrompt: string;
  taskInstruction: string;
  harnessUrl?: string;
  workspaceTree?: string;
  workspaceContext?: string;
  initialMessages?: Anthropic.MessageParam[];
  maxIterations?: number;
  maxTokens?: number;
  systemPromptOverride?: string;
  skipNudges?: boolean;
  logger?: import('pino').Logger;
}

