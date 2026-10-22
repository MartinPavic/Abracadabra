import { describe, expect, it } from "vitest";
import { describeError } from "./api";

describe("describeError", () => {
  it("words auth and timeout errors for the user", () => {
    expect(describeError({ kind: "auth" })).toContain("Settings");
    expect(describeError({ kind: "timeout" }, "gitlab.example.com")).toContain("gitlab.example.com");
  });

  it("shows the message of the other kinds", () => {
    for (const kind of ["not_found", "conflict", "git", "other"]) {
      expect(describeError({ kind, message: "nope" })).toBe("nope");
    }
  });

  it("passes plain string errors through", () => {
    expect(describeError("could not read config")).toBe("could not read config");
  });
});
