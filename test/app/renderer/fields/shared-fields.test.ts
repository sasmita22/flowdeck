import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const renderer = fileURLToPath(new URL("../../../../src/app/renderer/", import.meta.url));
const fieldsDir = resolve(renderer, "fields");

const sites = [
  ["Container settings", "inspector/container-settings.tsx"],
  ["the Build dialog", "build-dialog.tsx"],
] as const;

const sharedFields = ["RepoField", "BranchField", "ModelField"];

const sourceOf = (file: string) => {
  const path = resolve(renderer, file);
  return existsSync(path) ? readFileSync(path, "utf8") : "";
};

const blueprintSettingsFiles = () =>
  readdirSync(resolve(renderer, "inspector"))
    .filter((file) => file.endsWith(".tsx"))
    .map((file) => `inspector/${file}`)
    .filter((file) => /\bsettingsFields\(/.test(sourceOf(file)));

const fieldsImportedFromSharedModule = (file: string) =>
  [...sourceOf(file).matchAll(/import\s*\{(?<names>[^}]*)\}\s*from\s*"(?<from>[^"]+)"/g)]
    .map(({ groups }) => ({ names: groups?.names ?? "", from: groups?.from ?? "" }))
    .filter(({ from }) => dirname(resolve(renderer, dirname(file), from)) === fieldsDir)
    .flatMap(({ names }) => names.split(",").map((name) => name.trim()));

const ownedControlIds = [
  "buildDialogTestIds.repo",
  "buildDialogTestIds.base",
  "controlTestIds.buildModel",
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

  it.each(["inspector/container-settings.tsx", "inspector/library-settings.tsx"])(
    "%s loads the branches of the repository its branch field shows",
    (file) => {
      const source = sourceOf(file);
      const shown = /<BranchField\b[^>]*?\brepo=\{(?<repo>\w+)\}/.exec(source)?.groups?.repo;

      expect(shown).toBeDefined();
      expect(source).toMatch(
        new RegExp(
          `useEffect\\(\\(\\) => \\{\\s*void branches\\.getState\\(\\)\\.load\\(${shown}\\);`,
        ),
      );
    },
  );

  it.each(["build-dialog.tsx", "run-dialog.tsx"])(
    "%s draws its variables with the shared VariableField and defines none of its own",
    (file) => {
      expect(fieldsImportedFromSharedModule(file)).toContain("VariableField");
      expect(sourceOf(file)).toMatch(/<VariableField\b/);
      expect(sourceOf(file)).not.toMatch(/function VariableField\b/);
    },
  );

  it("the Run dialog gives each variable field its own Run dialog test id", () => {
    expect(sourceOf("run-dialog.tsx")).toMatch(
      /<VariableField\b[^>]*testId=\{dialogTestIds\.variable\(/,
    );
  });

  it("Blueprint settings draws the build model with the same model field as the Build dialog, under its own test id", () => {
    const files = blueprintSettingsFiles();
    expect(files).toHaveLength(1);
    const settings = sourceOf(files[0] ?? "");

    expect(settings).toMatch(/<ModelField\b/);
    expect(settings).not.toMatch(/controlTestIds\.buildModel|"build-model"/);
    expect(sourceOf("build-dialog.tsx")).toMatch(
      /<ModelField\b[^>]*testId=\{controlTestIds\.buildModel\}/,
    );
  });
});
