import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const renderer = fileURLToPath(new URL("../../../../src/app/renderer/", import.meta.url));
const pickerModule = resolve(renderer, "terminal/session-picker.tsx");

const sites = [
  ["The terminal pane", "terminal/terminal-pane.tsx"],
  ["The Inspector's Terminal tab", "inspector/terminal-tab.tsx"],
] as const;

const sourceOf = (file: string) => {
  const path = resolve(renderer, file);
  return existsSync(path) ? readFileSync(path, "utf8") : "";
};

const importsPickerFromSharedModule = (file: string) =>
  [...sourceOf(file).matchAll(/import\s*\{(?<names>[^}]*)\}\s*from\s*"(?<from>[^"]+)"/g)].some(
    ({ groups }) =>
      resolve(renderer, dirname(file), (groups?.from ?? "").replace(/\.js$/, ".tsx")) ===
        pickerModule &&
      (groups?.names ?? "")
        .split(",")
        .map((name) => name.trim())
        .includes("SessionPicker"),
  );

describe("same session picker on every terminal", () => {
  it.each(sites)("%s imports the session picker from the shared module", (_, file) => {
    expect(importsPickerFromSharedModule(file)).toBe(true);
  });

  it.each(sites)("%s renders the session picker", (_, file) => {
    expect(sourceOf(file)).toMatch(/<SessionPicker\b/);
  });

  it.each(sites)("%s draws no session option of its own", (_, file) => {
    expect(sourceOf(file)).not.toMatch(/terminalSessionPicker|terminalSessionOption/);
  });

  it.each(sites)("%s re-attaches its terminal when the chosen session changes", (_, file) => {
    expect(sourceOf(file)).toMatch(/<TerminalView\b[^>]*key=\{target\b/);
  });
});
