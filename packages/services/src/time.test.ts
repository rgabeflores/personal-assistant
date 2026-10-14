import { describe, expect, it } from "vitest";
import { uuidV5 } from "./ids.js";
import { localDate, spokenWhen, toLocalIso } from "./time.js";

describe("time", () => {
  it("formats with the zone's offset, including DST", () => {
    expect(toLocalIso(new Date("2026-10-07T01:00:00Z"), "America/Los_Angeles")).toBe("2026-10-06T18:00:00-07:00");
    expect(toLocalIso(new Date("2026-12-07T02:00:00Z"), "America/Los_Angeles")).toBe("2026-12-06T18:00:00-08:00");
    expect(toLocalIso(new Date("2026-10-06T12:30:00Z"), "Asia/Kolkata")).toBe("2026-10-06T18:00:00+05:30");
  });

  it("uses the local date, not the UTC date", () => {
    expect(localDate(new Date("2026-10-07T03:00:00Z"), "America/Los_Angeles")).toBe("2026-10-06");
  });

  it("speaks today, yesterday, or the date", () => {
    const now = new Date("2026-10-07T03:00:00Z"); // Oct 6, 8 PM Pacific
    const tz = "America/Los_Angeles";
    expect(spokenWhen(new Date("2026-10-07T01:00:00Z"), tz, now)).toBe("today at 6 PM");
    expect(spokenWhen(new Date("2026-10-06T01:30:00Z"), tz, now)).toBe("yesterday at 6:30 PM");
    expect(spokenWhen(new Date("2026-10-03T16:00:00Z"), tz, now)).toBe("Sat, Oct 3 at 9 AM");
  });
});

describe("uuidV5", () => {
  it("is deterministic and well-formed", () => {
    const a = uuidV5("3f9a:tool:0");
    expect(a).toBe(uuidV5("3f9a:tool:0"));
    expect(a).not.toBe(uuidV5("3f9a:tool:1"));
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
