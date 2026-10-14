import { ModelError, type ModelAdapter, type ModelEvent, type ModelRequest } from "../types.js";

/**
 * Plays back canned responses, one per call. Used by unit tests and offline evals.
 * A step can be a list of events or an error to throw before anything streams.
 */
export type ScriptStep = ModelEvent[] | ModelError | ((req: ModelRequest) => ModelEvent[]);

export class ScriptedAdapter implements ModelAdapter {
  readonly requests: { model: string; req: ModelRequest }[] = [];
  private steps: ScriptStep[];

  constructor(steps: ScriptStep[]) {
    this.steps = [...steps];
  }

  async *stream(model: string, req: ModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push({ model, req: structuredClone(req) });
    const step = this.steps.shift();
    if (!step) throw new ModelError("ScriptedAdapter ran out of steps", false);
    if (step instanceof ModelError) throw step;
    for (const ev of typeof step === "function" ? step(req) : step) yield ev;
  }
}
