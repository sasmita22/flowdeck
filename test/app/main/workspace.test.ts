import { describe, expect, it, vi } from "vitest";
import { createWindowGuard, type SenderFrame } from "../../../src/app/main/window-guard.js";
import { workspaceInfoHandler } from "../../../src/app/main/workspace.js";

const appUrl = "file:///Applications/Flowdeck.app/renderer/main_window/index.html";
const buildConfig = { repo: "/code/shop", base: "main", variables: [] };

const setup = () => {
  const request = vi.fn(async () => ({ kind: "branch", name: "fd-demo" }));
  const handler = workspaceInfoHandler(createWindowGuard({ appUrl }), { request });
  return { request, handler };
};

describe("workspaceInfoHandler", () => {
  it("asks the engine for the working folder's state when the app page invokes it", async () => {
    const { request, handler } = setup();

    await expect(
      handler({ senderFrame: { url: appUrl, parent: null } }, buildConfig),
    ).resolves.toEqual({ kind: "branch", name: "fd-demo" });
    expect(request).toHaveBeenCalledExactlyOnceWith("workspace-info", { buildConfig });
  });

  it.each<[string, SenderFrame]>([
    ["a missing frame", null],
    ["a subframe of the app page", { url: appUrl, parent: {} }],
    ["another page", { url: "https://example.com/", parent: null }],
  ])("refuses %s without asking the engine", (_label, senderFrame) => {
    const { request, handler } = setup();

    expect(() => handler({ senderFrame }, buildConfig)).toThrow("IPC sender is not the app page");
    expect(request).not.toHaveBeenCalled();
  });
});
