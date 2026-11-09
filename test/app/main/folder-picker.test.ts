import { describe, expect, it, vi } from "vitest";
import { folderPickerHandler } from "../../../src/app/main/folder-picker.js";
import { createWindowGuard, type SenderFrame } from "../../../src/app/main/window-guard.js";

const appUrl = "file:///Applications/Flowdeck.app/renderer/main_window/index.html";
const appPage = { senderFrame: { url: appUrl, parent: null } };

type Reply = { canceled: boolean; filePaths: string[] };

const setup = (reply: Reply = { canceled: false, filePaths: ["/x"] }) => {
  const window = { id: 1 };
  const showOpenDialog = vi.fn<(parent: unknown, options: unknown) => Promise<Reply>>(
    async () => reply,
  );
  const dialog = { showOpenDialog };
  const handler = folderPickerHandler(createWindowGuard({ appUrl }), { dialog, window });
  return { window, dialog, showOpenDialog, handler };
};

describe("folderPickerHandler", () => {
  it("resolves the picked folder when the app page invokes it", async () => {
    const { handler } = setup();

    await expect(handler(appPage)).resolves.toBe("/x");
  });

  it("asks for a directory, parented to the app window", async () => {
    const { handler, showOpenDialog, window } = setup();

    await handler(appPage);

    expect(showOpenDialog).toHaveBeenCalledOnce();
    const [parent, options] = showOpenDialog.mock.calls[0] ?? [];
    expect(parent).toBe(window);
    expect(options).toMatchObject({ properties: expect.arrayContaining(["openDirectory"]) });
  });

  it.each<[string, Reply]>([
    ["is cancelled", { canceled: true, filePaths: [] }],
    ["returns no folder", { canceled: false, filePaths: [] }],
  ])("resolves null when the picker %s", async (_label, reply) => {
    const { handler } = setup(reply);

    await expect(handler(appPage)).resolves.toBeNull();
  });

  it.each<[string, SenderFrame]>([
    ["a missing frame", null],
    ["a subframe of the app page", { url: appUrl, parent: {} }],
    ["another page", { url: "https://example.com/", parent: null }],
  ])("refuses %s without opening a dialog", async (_label, senderFrame) => {
    const { handler, showOpenDialog } = setup();

    await expect(Promise.resolve().then(() => handler({ senderFrame }))).rejects.toThrow(
      "IPC sender is not the app page",
    );
    expect(showOpenDialog).not.toHaveBeenCalled();
  });

  it("calls the dialog's showOpenDialog as it is when invoked, not when built", async () => {
    const { handler, dialog, showOpenDialog } = setup();
    const replaced = vi.fn(async () => ({ canceled: false, filePaths: ["/stubbed"] }));
    dialog.showOpenDialog = replaced;

    await expect(handler(appPage)).resolves.toBe("/stubbed");
    expect(showOpenDialog).not.toHaveBeenCalled();
  });
});
