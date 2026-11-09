import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const renderer = fileURLToPath(new URL("../../../../src/app/renderer/", import.meta.url));
const fieldsDir = resolve(renderer, "fields");

const sites = [
  ["Blueprint settings", "inspector/session-settings.tsx"],
  ["the Build dialog", "build-dialog.tsx"],
] as const;

const sharedFields = ["RepoField", "BranchField", "ModelField"];

const sourceOf = (file: string) => readFileSync(resolve(renderer, file), "utf8");

const fieldsImportedFromSharedModule = (file: string) =>
  [...sourceOf(file).matchAll(/import\s*\{(?<names>[^}]*)\}\s*from\s*"(?<from>[^"]+)"/g)]
    .map(({ groups }) => ({ names: groups?.names ?? "", from: groups?.from ?? "" }))
    .filter(({ from }) => dirname(resolve(renderer, dirname(file), from)) === fieldsDir)
    .flatMap(({ names }) => names.split(",").map((name) => name.trim()));

const ownedControlIds = [
  "buildConfigTestIds.repo",
  "buildConfigTestIds.base",
  "buildDialogTestIds.repo",
  "buildDialogTestIds.base",
  "controlTestIds.buildModel",
  "session-build-config-repo",
  "session-build-config-base",
  "build-dialog-repo",
  "build-dialog-base",
  "build-model",
  "session-model",
];

const ownControlsFor = (file: string) =>
  [...sourceOf(file).matchAll(/<(input|select)\b[^<]*?data-testid=(\{[^}]*\}|"[^"]*")/g)]
    .map(([, tag, id]) => `<${tag} ${id}>`)
    .filter((control) => ownedControlIds.some((id) => control.includes(id)));

describe("same setting, same field", () => {
  it.each(sites)(
    "%s imports the repository, branch and model fields from the shared module",
    (_, file) => {
      expect(fieldsImportedFromSharedModule(file)).toEqual(expect.arrayContaining(sharedFields));
    },
  );

  it.each(sites)("%s renders the repository, branch and model fields", (_, file) => {
    const source = sourceOf(file);

    for (const field of sharedFields) expect(source).toMatch(new RegExp(`<${field}\\b`));
  });

  it.each(sites)(
    "%s draws no input or select of its own for the repository, branch or model",
    (_, file) => {
      expect(ownControlsFor(file)).toEqual([]);
    },
  );
});
