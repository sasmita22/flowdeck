import { type LaunchedApp } from "../scripts/drive.js";

export const exited = (launched: LaunchedApp) =>
  new Promise<void>((resolve) => {
    const proc = launched.app.process();
    if (proc.exitCode !== null || proc.signalCode !== null) resolve();
    else proc.once("exit", () => resolve());
  });

const targetClosed = (error: unknown) =>
  error instanceof Error &&
  error.message.includes("Target page, context or browser has been closed");

export const clickToQuit = async (launched: LaunchedApp, testid: string) => {
  const exit = exited(launched);
  try {
    await launched.window.getByTestId(testid).click();
  } catch (error) {
    if (!targetClosed(error)) throw error;
  }
  await exit;
};
