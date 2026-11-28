import { expect } from "vitest";

export function expectBareHandoffRule(text: string, folder: string): void {
  expect(text).toMatch(/by bare name/);
  expect(text).toContain("the run's working folder");
  expect(text).toContain(`\`${folder}/\``);
  expect(text).toContain("this session's own folder");
  expect(text).not.toMatch(/in this build's workspace/i);
  expect(text).not.toMatch(/never use the workspace folder itself/i);
}
