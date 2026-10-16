import { describe, expect, it } from "vitest";
import { planKeySync } from "./key-sync-plan.js";

describe("planKeySync", () => {
  it("creates, updates, or leaves a secret based on the local key", () => {
    expect(planKeySync("k", { exists: false, value: undefined })).toBe("create");
    expect(planKeySync("k", { exists: true, value: undefined })).toBe("update"); // template-created, empty
    expect(planKeySync("k2", { exists: true, value: "k1" })).toBe("update");
    expect(planKeySync("k", { exists: true, value: "k" })).toBe("unchanged");
  });

  it("never clears a secret when there is no local key", () => {
    expect(planKeySync(undefined, { exists: true, value: "k" })).toBe("keep");
    expect(planKeySync(undefined, { exists: true, value: undefined })).toBe("missing");
    expect(planKeySync(undefined, { exists: false, value: undefined })).toBe("missing");
  });
});
