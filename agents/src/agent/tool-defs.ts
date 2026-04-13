import type Anthropic from "@anthropic-ai/sdk";

export const TOOL_DEFS: Anthropic.Tool[] = [
  {
    name: "execute_code",
    description:
      "Execute Python code against the workspace. " +
      "Pre-loaded: `ws` (Workspace — tree, find, search, list, read, write, delete, mkdir, move, context, answer), " +
      "`scratchpad` (persistent dict — survives between calls). " +
      "Variables you define also persist between calls (JSON-serializable only). " +
      "Call ws.answer(scratchpad, verify) to submit — it runs your verify(sp) function first. " +
      "Use print() for output.",
    input_schema: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description: "Python 3 code to execute.",
        },
      },
      required: ["code"],
    },
  },
];
