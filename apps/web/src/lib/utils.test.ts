import { describe, it, expect } from "vitest";
import { cn } from "./utils";

describe("cn", () => {
  it("joins truthy class values", () => {
    expect(cn("a", "b")).toBe("a b");
    expect(cn("a", false, undefined, null, "b")).toBe("a b");
  });

  it("de-duplicates conflicting tailwind utilities (last wins)", () => {
    expect(cn("px-2", "px-4")).toBe("px-4");
    expect(cn("flex", { "text-accent": true })).toBe("flex text-accent");
  });
});
