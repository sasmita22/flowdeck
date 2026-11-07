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

const firstRow = <T>(home: string, sql: string, name: string): T | undefined => {
  const db = new Database(join(home, "flowdeck.db"), { readonly: true });
  try {
    return db.prepare(sql).get(name) as T | undefined;
  } finally {
    db.close();
  }
};

export const buildIdNamed = (home: string, name: string): string => {
  const row = firstRow<{ id: string }>(
    home,
    "SELECT id FROM builds WHERE name = ? AND deleted_at IS NULL",
    name,
  );
  if (row === undefined) throw new Error(`no build named ${name} was recorded`);
  return row.id;
};

const flowIdOfPendingBuild = async (home: string, name: string): Promise<string> => {
  const sql = "SELECT flow_id FROM pending_builds WHERE name = ? ORDER BY started_at DESC";
  await expect.poll(() => firstRow<{ flow_id: string }>(home, sql, name)?.flow_id).toBeDefined();
  return firstRow<{ flow_id: string }>(home, sql, name)?.flow_id ?? "";
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
  return waitForBuilt(window, home, name);
}

export async function waitForBuilt(window: Page, home: string, name: string): Promise<string> {
  const flowId = await flowIdOfPendingBuild(home, name);
  const builtSql = "SELECT id FROM builds WHERE name = ? AND deleted_at IS NULL";
  await expect
    .poll(() => firstRow<{ id: string }>(home, builtSql, name)?.id, { timeout: 20_000 })
    .toBeDefined();
  await window.getByTestId("menu-blueprints").click();
  await expect(window.getByTestId(pageTestIds.buildChip(flowId))).toHaveText(/^Built · v\d+$/, {
    timeout: 20_000,
  });
  const buildId = buildIdNamed(home, name);
  await window.getByTestId("menu-builds").click();
  await window.getByTestId(pageTestIds.buildOpen(buildId)).click();
  await expect(window.getByTestId(pageTestIds.buildDetailRun)).toBeVisible();
  return buildId;
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
