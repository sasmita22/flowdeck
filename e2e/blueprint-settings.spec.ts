import { expect, test } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { controlTestIds } from "../src/app/renderer/test-ids.js";
import { type LaunchedApp } from "../scripts/drive.js";
import { launchWithFakeClaude } from "./fake-claude.js";

let home: string;
let launched: LaunchedApp | undefined;

test.beforeEach(async () => {
  launched = undefined;
  home = await mkdtemp(join(tmpdir(), "fd-bs-"));
});

test.afterEach(async () => {
  try {
    await launched?.close();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("Blueprint settings show the build model and permission mode, and no budget, allowed tools or connectors", async () => {
  launched = await launchWithFakeClaude({ home, logPath: test.info().outputPath("app.log") });
  const { window } = launched;
  await window.getByTestId(controlTestIds.sessionSettings).click();
  const settings = window.getByTestId("session-settings");
  await expect(settings).toBeVisible();

  await expect(settings.getByTestId("settings-build-model")).toBeVisible();
  await expect(settings.getByRole("combobox", { name: "Build model", exact: true })).toBeVisible();
  await expect(settings.getByTestId("settings-permission-mode")).toBeVisible();
  await expect(
    settings.getByRole("combobox", { name: "Permission mode", exact: true }),
  ).toBeVisible();

  for (const removed of ["budget", "allowed-tools", "connectors"]) {
    await expect(window.locator(`[data-testid$="-${removed}"]`)).toHaveCount(0);
  }
  for (const removed of [/budget/i, /allowed tools/i, /connector/i]) {
    await expect(settings.getByText(removed)).toHaveCount(0);
    await expect(settings.getByLabel(removed)).toHaveCount(0);
  }
});
