import { logEntryTool } from "./log-entry.js";
import type { Tool } from "./types.js";

export * from "./types.js";

/** Every tool the chat agent can call. Phase 1 has one; later phases add the rest of ARCH §5. */
export const TOOLS: Tool[] = [logEntryTool];

export function toolByName(name: string, tools: Tool[] = TOOLS): Tool | undefined {
  return tools.find((t) => t.def.name === name);
}
