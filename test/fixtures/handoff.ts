import { expect } from "vitest";

export function expectBareHandoffRule(text: string, folder: string): void {
  expect(text).toMatch(/by bare name/);
  expect(text).toContain("the run's working folder");
  expect(text).toContain(`\`${folder}/\``);
  expect(text).toMatch(/never use the workspace folder itself/i);
}

export function nestedHandoffPaths(
  text: string,
  folder: string,
  files: readonly string[],
): string[] {
  return files
    .map((file) => `${folder}/${file}`)
    .filter((path) => text.replaceAll(`not \`${path}\``, "").includes(path));
}
