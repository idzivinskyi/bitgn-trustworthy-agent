// ── Python code executor for agent ──────────────────────
//
// Writes agent code to a temp .py file, spawns Python 3.14,
// captures stdout/stderr. The Python code uses the Workspace
// class (pre-loaded in the prelude) for all workspace operations.

import { execFile } from "node:child_process";
import { writeFile, readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
const TIMEOUT_MS = 120_000;
const PYTHON_BIN = "/app/.venv/bin/python";

export function buildPythonPrelude(scratchpadPath: string, statePath: string): string {
  return `\
import json, sys, atexit, os, re, csv, math, hashlib, base64, yaml
from datetime import datetime, timedelta, date
from collections import defaultdict, Counter
from pathlib import PurePosixPath
from dateutil import parser as dateutil_parser
from dateutil.relativedelta import relativedelta
sys.path.insert(0, "/app/python")
from workspace import Workspace
ws = Workspace()

_SCRATCHPAD_PATH = "${scratchpadPath}"
_STATE_PATH = "${statePath}"

def _load_scratchpad():
    try:
        with open(_SCRATCHPAD_PATH) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}

def _save_scratchpad():
    with open(_SCRATCHPAD_PATH, "w") as f:
        json.dump(scratchpad, f)

scratchpad = _load_scratchpad()
import builtins as _builtins
_builtins.scratchpad = scratchpad
atexit.register(_save_scratchpad)

def _print_scratchpad_state():
    if scratchpad:
        print(f"\\n[scratchpad: {json.dumps(scratchpad)}]")

atexit.register(_print_scratchpad_state)

# Persist user-defined variables between execute_code calls.
# Only JSON-serializable values survive (str, int, float, bool, list, dict, None).
_PRELUDE_NAMES = set(dir())

def _load_state():
    try:
        with open(_STATE_PATH) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}

def _save_state():
    state = {}
    for k, v in globals().items():
        if k.startswith("_") or k in _PRELUDE_NAMES:
            continue
        try:
            json.dumps(v)
            state[k] = v
        except (TypeError, ValueError):
            pass
    with open(_STATE_PATH, "w") as f:
        json.dump(state, f)

globals().update(_load_state())
atexit.register(_save_state)
`;
}

export async function resetScratchpad(scratchpadPath: string, seed?: Record<string, unknown>): Promise<void> {
  await writeFile(scratchpadPath, JSON.stringify(seed ?? {}), "utf-8");
}

export async function resetTracking(trackingPath: string): Promise<void> {
  await writeFile(trackingPath, "{}", "utf-8");
}

export async function readScratchpad(scratchpadPath: string): Promise<Record<string, unknown> | null> {
  try {
    const data = await readFile(scratchpadPath, "utf-8");
    const parsed = JSON.parse(data) as Record<string, unknown>;
    return Object.keys(parsed).length > 0 ? parsed : null;
  } catch {
    return null;
  }
}

export async function executeCode(
  code: string,
  harnessUrl: string,
  scratchpadPath: string,
  statePath: string,
  answerPath?: string,
  trackingPath?: string,
): Promise<{ content: string; is_error?: boolean }> {
  const tmpFile = join(tmpdir(), `agent-${randomBytes(6).toString("hex")}.py`);

  try {
    await writeFile(tmpFile, buildPythonPrelude(scratchpadPath, statePath) + code, "utf-8");

    const result = await new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve) => {
      execFile(
        PYTHON_BIN,
        [tmpFile],
        {
          timeout: TIMEOUT_MS,
          maxBuffer: 10 * 1024 * 1024,
          env: {
            ...process.env,
            RUNTIME_HARNESS_URL: harnessUrl,
            ...(answerPath ? { AGENT_ANSWER_PATH: answerPath } : {}),
            ...(trackingPath ? { AGENT_TRACKING_PATH: trackingPath } : {}),
          },
        },
        (err, stdout, stderr) => {
          const exitCode = err && "code" in err ? (err.code as number) ?? 1 : err ? 1 : 0;
          resolve({ stdout: stdout ?? "", stderr: stderr ?? "", exitCode });
        },
      );
    });

    const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();

    if (result.exitCode !== 0) {
      return { content: output || `Process exited with code ${result.exitCode}`, is_error: true };
    }

    return { content: output || "ok" };
  } catch (err) {
    return { content: err instanceof Error ? err.message : String(err), is_error: true };
  } finally {
    await unlink(tmpFile).catch(() => {});
  }
}
