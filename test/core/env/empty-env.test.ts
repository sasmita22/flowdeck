import { describe, expect, it } from "vitest";
import { carryEmptyEnv, emptyEnvOf } from "../../../src/core/env/empty-env.js";

describe("carryEmptyEnv", () => {
  it("keeps every entry and names the empty ones in FLOWDECK_EMPTY_ENV", () => {
    expect(carryEmptyEnv({ A: "", B: "x", C: undefined })).toEqual({
      A: "",
      B: "x",
      C: undefined,
      FLOWDECK_EMPTY_ENV: '["A"]',
    });
  });

  it("adds nothing when no value is empty", () => {
    expect(carryEmptyEnv({ B: "x", C: undefined })).toEqual({ B: "x", C: undefined });
  });
});

describe("emptyEnvOf", () => {
  it("gives each named variable an empty value", () => {
    expect(emptyEnvOf({ FLOWDECK_EMPTY_ENV: '["A","B"]' })).toEqual({ A: "", B: "" });
  });

  it("gives nothing without the carrier", () => {
    expect(emptyEnvOf({ A: "x" })).toEqual({});
  });

  it.each(["not json", '"A"', '{"A":""}', "null"])(
    "gives nothing for the carrier %s",
    (carrier) => {
      expect(emptyEnvOf({ FLOWDECK_EMPTY_ENV: carrier })).toEqual({});
    },
  );

  it("gives back exactly the empty entries after a fork drops them", () => {
    const env = { A: "", B: "x", C: "", D: undefined };
    const forked = Object.fromEntries(
      Object.entries(carryEmptyEnv(env)).filter(([, value]) => value !== ""),
    );

    expect(emptyEnvOf(forked)).toEqual({ A: "", C: "" });
  });
});
