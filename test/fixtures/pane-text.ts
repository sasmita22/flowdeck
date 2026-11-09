import { expect, vi } from "vitest";

export async function expectPaneToShow(
  capture: () => Promise<string>,
  text: string,
  timeout = 10_000,
): Promise<void> {
  await vi.waitFor(async () => expect(await capture()).toContain(text), { timeout });
}
