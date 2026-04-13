import pino from "pino";
import type { AgentEvent } from "../agent-types";

export type Logger = pino.Logger;

/**
 * Create a logger with the given level.
 * @param level - pino log level string
 * @param name  - optional logger name (bound as `name` field)
 *
 * In test environments (NODE_ENV=test) the pino-pretty transport is skipped
 * to avoid noise and transport worker overhead.
 */
export function createLogger(level: string, name?: string): Logger {
  const isTest = process.env.NODE_ENV === "test";
  const isTTY = process.stdout.isTTY === true;
  const usePretty = !isTest && isTTY;

  const options: pino.LoggerOptions = {
    level,
    ...(name ? { name } : {}),
  };

  if (usePretty) {
    return pino({
      ...options,
      transport: {
        target: "pino-pretty",
        options: { colorize: true, ignore: "pid,hostname" },
      },
    });
  }

  return pino(options);
}

/**
 * Create a no-op silent logger for tests and default fallback.
 */
export function createSilentLogger(): Logger {
  return pino({ level: "silent" });
}

export function logEvent(event: AgentEvent, pfx: string, write: (msg: string) => void): void {
  switch (event.kind) {
    case "api_call": {
      let msg = `${pfx}[iter ${event.iteration}] tokens: in=${event.inputTokens} out=${event.outputTokens}`;
      if (event.cacheReadTokens > 0 || event.cacheCreateTokens > 0) {
        msg += ` cache: read=${event.cacheReadTokens} create=${event.cacheCreateTokens}`;
      }
      msg += ` (${event.durationMs}ms)`;
      write(msg);
      break;
    }
    case "text":
      if (event.text.trim()) {
        write(`${pfx}${event.text}`);
      }
      break;
    case "tool_call":
      if (event.name === "execute_code" && typeof event.input.code === "string") {
        write(`${pfx}── execute_code ──`);
        for (const line of event.input.code.split("\n")) {
          write(`${pfx}│ ${line}`);
        }
        write(`${pfx}──────────────────`);
      } else {
        write(`${pfx}-> ${event.name}(${JSON.stringify(event.input)})`);
      }
      break;
    case "tool_result": {
      if (event.isError) {
        write(`${pfx}✗ ${event.name}:`);
        for (const line of event.result.split("\n")) {
          write(`${pfx}  ${line}`);
        }
      } else {
        write(`${pfx}← ${event.name}: ${event.result}`);
      }
      break;
    }
    case "scratchpad": {
      write(`${pfx}── scratchpad ──`);
      for (const line of JSON.stringify(event.scratchpad, null, 2).split("\n")) {
        write(`${pfx}│ ${line}`);
      }
      write(`${pfx}─────────────────`);
      break;
    }
    case "compaction": {
      write(`${pfx}── compaction: ${event.fromMessages} → ${event.toMessages} messages ──`);
      break;
    }
  }
}
