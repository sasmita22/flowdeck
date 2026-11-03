import { expect, type Page } from "@playwright/test";
import Database from "better-sqlite3";
import { join } from "node:path";
import {
  buildDialogTestIds,
  controlTestIds,
  dialogTestIds,
  pageTestIds,
} from "../src/app/renderer/test-ids.js";

export type BuildValues = Record<string, string | boolean>;

export const buildIdNamed = (home: string, name: string): string => {
  const db = new Database(join(home, "flowdeck.db"), { readonly: true });
  try {
    const row = db
      .prepare("SELECT id FROM builds WHERE name = ? AND deleted_at IS NULL")
      .get(name) as { id: string } | undefined;
    if (row === undefined) throw new Error(`no build named ${name} was recorded`);
    return row.id;
  } finally {
    db.close();
  }
};

export async function buildOnCanvas(
  window: Page,
  home: string,
  name: string,
  values: BuildValues = {},
): Promise<string> {
  await window.getByTestId(controlTestIds.build).click();
  await expect(window.getByTestId(buildDialogTestIds.dialog)).toBeVisible();
  await window.getByTestId(buildDialogTestIds.name).fill(name);
  for (const [variable, value] of Object.entries(values)) {
    const field = window.getByTestId(buildDialogTestIds.variable(variable));
    if (typeof value === "boolean") await field.selectOption(value ? "yes" : "no");
    else await field.fill(value);
  }
  await window.getByTestId(buildDialogTestIds.confirm).click();
  await expect(window.getByTestId(buildDialogTestIds.dialog)).toBeHidden();
  await expect(window.getByTestId(pageTestIds.buildDetailRun)).toBeVisible();
  return buildIdNamed(home, name);
}

export async function runFromDetail(window: Page): Promise<void> {
  await window.getByTestId(pageTestIds.buildDetailRun).click();
  const dialog = window.getByTestId(dialogTestIds.dialog);
  await expect(dialog.or(window.getByTestId(pageTestIds.runPageStatus))).toBeVisible();
  if (await dialog.isVisible()) {
    await window.getByTestId(dialogTestIds.start).click();
    await expect(dialog).toBeHidden();
  }
}

export async function buildAndRun(
  window: Page,
  home: string,
  name: string,
  values: BuildValues = {},
): Promise<string> {
  const buildId = await buildOnCanvas(window, home, name, values);
  await runFromDetail(window);
  return buildId;
}
