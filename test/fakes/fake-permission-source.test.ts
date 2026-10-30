import { describe, expect, it, vi } from "vitest";
import type { PermissionDecision } from "../../src/ports/permission-source.js";
import { FakePermissionSource } from "./fake-permission-source.js";

const payload = { tool_name: "Bash", tool_input: { command: "echo hi" } };
const allow: PermissionDecision = { behavior: "allow" };
const nobody: PermissionDecision = { behavior: "deny", message: "No run is listening" };

describe("FakePermissionSource", () => {
  it("answers an ask with the decision of the handler for its session", async () => {
    const source = new FakePermissionSource();
    const handler = vi.fn(async () => allow);
    source.onRequest("s1", handler);

    await expect(source.ask("s1", payload)).resolves.toEqual(allow);
    expect(handler).toHaveBeenCalledWith(payload, expect.any(AbortSignal));
  });

  it("hands the asker's signal to the handler", async () => {
    const source = new FakePermissionSource();
    const handler = vi.fn(async () => allow);
    source.onRequest("s1", handler);
    const hook = new AbortController();

    await source.ask("s1", payload, hook.signal);

    expect(handler).toHaveBeenCalledWith(payload, hook.signal);
  });

  it("denies an ask when no handler listens", async () => {
    const source = new FakePermissionSource();

    await expect(source.ask("s1", payload)).resolves.toEqual(nobody);
  });

  it("denies an ask once the handler unsubscribed", async () => {
    const source = new FakePermissionSource();
    const unsubscribe = source.onRequest("s1", async () => allow);

    unsubscribe();

    await expect(source.ask("s1", payload)).resolves.toEqual(nobody);
  });

  it("does not call the handler of another session", async () => {
    const source = new FakePermissionSource();
    const handler = vi.fn(async () => allow);
    source.onRequest("s2", handler);

    await expect(source.ask("s1", payload)).resolves.toEqual(nobody);
    expect(handler).not.toHaveBeenCalled();
  });
});
