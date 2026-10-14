import { loadModelConfig, splitRef, type Routes } from "./routing.js";
import {
  ModelError,
  type Block,
  type ModelAdapter,
  type ModelEvent,
  type ModelRef,
  type ModelRequest,
  type ModelTask,
  type StopReason,
  type Usage,
} from "./types.js";

export type CompleteResult = {
  content: Block[];
  stopReason: StopReason;
  usage: Usage;
  model: ModelRef;
};

/**
 * The only way the rest of the backend calls a model (D-48). Routes a task to its configured
 * model and falls back only before anything has streamed (D-51).
 */
export class ModelRouter {
  constructor(
    private readonly adapters: Record<string, ModelAdapter>,
    private readonly routes: Routes = loadModelConfig().routes,
  ) {}

  async *streamModel(task: ModelTask, req: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelEvent> {
    const route = this.routes[task];
    // Primary, primary again (one retry), then the fallback.
    const attempts: ModelRef[] = [route.primary, route.primary, ...(route.fallback ? [route.fallback] : [])];
    let lastError: unknown;

    for (const ref of attempts) {
      const { provider, model } = splitRef(ref);
      const adapter = this.adapters[provider];
      if (!adapter) throw new ModelError(`No adapter registered for provider "${provider}"`, false);

      let emitted = false;
      try {
        for await (const ev of adapter.stream(model, req, signal)) {
          emitted = true;
          yield ev;
        }
        return;
      } catch (err) {
        // Once output reached the caller, the turn fails rather than switching models mid-reply.
        if (emitted || !(err instanceof ModelError) || !err.retryable) throw err;
        lastError = err;
      }
    }
    throw lastError;
  }

  /**
   * Consumes streamModel, forwards text deltas, and returns the collected canonical content.
   * The agent loop uses this (ARCH §4).
   */
  async complete(
    task: ModelTask,
    req: ModelRequest,
    opts: { onText?: (text: string) => void; signal?: AbortSignal } = {},
  ): Promise<CompleteResult> {
    const content: Block[] = [];
    let text = "";
    const flushText = () => {
      if (text) content.push({ type: "text", text });
      text = "";
    };

    for await (const ev of this.streamModel(task, req, opts.signal)) {
      switch (ev.type) {
        case "text.delta":
          text += ev.text;
          opts.onText?.(ev.text);
          break;
        case "tool_call":
          flushText();
          content.push({ type: "tool_call", id: ev.id, name: ev.name, input: ev.input });
          break;
        case "done":
          flushText();
          return { content, stopReason: ev.stopReason, usage: ev.usage, model: ev.model };
      }
    }
    throw new ModelError("Model stream ended without a done event", true);
  }
}
