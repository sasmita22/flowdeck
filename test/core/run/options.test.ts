import { describe, expect, it } from "vitest";
import {
  runChoicesSchema,
  runValues,
  runVariables,
  storedAuto,
  storedOptions,
} from "../../../src/core/run/options.js";

describe("runChoicesSchema", () => {
  it("accepts choices carrying the yes/no variables the run may change", () => {
    const choices = { kind: "choices", variables: [{ name: "approved", value: true }] };

    expect(runChoicesSchema.parse(choices)).toEqual(choices);
  });

  it("refuses a variable that is not yes or no", () => {
    expect(
      runChoicesSchema.safeParse({ kind: "choices", variables: [{ name: "t", value: "x" }] })
        .success,
    ).toBe(false);
  });

  it("accepts an error with its message", () => {
    expect(runChoicesSchema.parse({ kind: "error", message: "x" })).toEqual({
      kind: "error",
      message: "x",
    });
  });
});

describe("runVariables", () => {
  it("lists the build's yes/no variables with the build's values, leaving text out", () => {
    expect(runVariables({ approved: true, ticket: "FD-1", docs: false })).toEqual([
      { name: "approved", value: true },
      { name: "docs", value: false },
    ]);
  });

  it("lists nothing for a build without values", () => {
    expect(runVariables(undefined)).toEqual([]);
  });
});

describe("stored run options", () => {
  it("keeps automatic mode in the stored record", () => {
    expect(storedOptions({ auto: true })).toEqual({ auto: true });
    expect(storedOptions({ auto: false })).toEqual({});
  });

  it("keeps the run's yes/no values in the stored record", () => {
    expect(storedOptions({ auto: false, variables: { approved: false } })).toEqual({
      variables: { approved: false },
    });
    expect(storedOptions({ auto: true, variables: {} })).toEqual({ auto: true });
  });

  it("reads back automatic mode for a resume", () => {
    expect(storedAuto({ ticket: "FD-1", deep: false, auto: true })).toBe(true);
    expect(storedAuto({ auto: "yes" })).toBe(false);
  });
});

describe("runValues", () => {
  it("lays the stored run values over the build's values, changing neither", () => {
    const build = { approved: false, ticket: "FD-1" };
    const stored = { auto: true, variables: { approved: true } };

    expect(runValues(build, stored)).toEqual({ approved: true, ticket: "FD-1" });
    expect(build).toEqual({ approved: false, ticket: "FD-1" });
    expect(stored).toEqual({ auto: true, variables: { approved: true } });
  });

  it("keeps the build's values when the run stored none", () => {
    expect(runValues({ approved: false }, {})).toEqual({ approved: false });
  });

  it("never changes a text variable or adds a name the build has no yes/no value for", () => {
    expect(
      runValues(
        { ticket: "FD-1", approved: false },
        { variables: { ticket: true, other: true, approved: "yes" } },
      ),
    ).toEqual({ ticket: "FD-1", approved: false });
  });

  it("reads nothing from a stored record whose variables are not an object", () => {
    expect(runValues({ approved: false }, { variables: ["approved"] })).toEqual({
      approved: false,
    });
  });
});
