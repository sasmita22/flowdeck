import type { WindowGuard } from "./window-guard.js";

type FolderDialog<W> = {
  showOpenDialog(
    window: W,
    options: { properties: ["openDirectory"] },
  ): Promise<{ canceled: boolean; filePaths: string[] }>;
};

export const folderPickerHandler = <W>(
  guard: WindowGuard,
  { dialog, window }: { dialog: FolderDialog<W>; window: W },
) =>
  guard.handle(async (): Promise<string | null> => {
    const { canceled, filePaths } = await dialog.showOpenDialog(window, {
      properties: ["openDirectory"],
    });
    return canceled ? null : (filePaths[0] ?? null);
  });
