import { describe, expect, it } from "vitest";
import { FakeConnectorSource } from "./fake-connector-source.js";

describe("FakeConnectorSource", () => {
  it("finds a copy of a seeded connector and nothing for an unknown name", async () => {
    const definition = { type: "http", url: "https://x" };
    const source = new FakeConnectorSource({ jira: definition });

    const found = await source.find("jira");

    expect(found).toEqual(definition);
    expect(found).not.toBe(definition);
    expect(await source.find("slack")).toBeUndefined();
    expect(source.calls).toEqual(["jira", "slack"]);
  });
});
