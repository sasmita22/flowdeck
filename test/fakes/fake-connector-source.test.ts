import { describe, expect, it } from "vitest";
import { FakeConnectorSource } from "./fake-connector-source.js";

describe("FakeConnectorSource", () => {
  it("has no lookup of one connector by name", () => {
    expect("find" in new FakeConnectorSource()).toBe(false);
  });

  it("lists copies of every seeded connector", async () => {
    const definition = { type: "http", url: "https://x" };
    const source = new FakeConnectorSource({ jira: definition });

    const listed = await source.list();

    expect(listed).toEqual({ jira: definition });
    expect(listed["jira"]).not.toBe(definition);
  });
});
