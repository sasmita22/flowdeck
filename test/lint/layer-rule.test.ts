import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const eslint = new ESLint({ cwd: repoRoot });

const ruleIdsFor = async (code: string): Promise<(string | null)[]> => {
  const results = await eslint.lintText(code, { filePath: "src/app/renderer/layer-probe.ts" });
  return results.flatMap((result) => result.messages.map((message) => message.ruleId));
};

describe("layer rule for the renderer", { timeout: 30_000 }, () => {
  it("lets the renderer import core", async () => {
    expect(
      await ruleIdsFor('import { parseFlow } from "../../core/flow/schema.js";\nvoid parseFlow;\n'),
    ).not.toContain("boundaries/dependencies");
  });

  it("stops the renderer importing ports", async () => {
    expect(await ruleIdsFor('import "../../ports/store.js";\n')).toContain(
      "boundaries/dependencies",
    );
  });

  it("stops the renderer importing adapters", async () => {
    expect(await ruleIdsFor('import "../../adapters/sqlite/sqlite-store.js";\n')).toContain(
      "boundaries/dependencies",
    );
  });

  it("stops the renderer importing Node built-ins", async () => {
    expect(
      await ruleIdsFor('import { readFileSync } from "node:fs";\nvoid readFileSync;\n'),
    ).toContain("no-restricted-imports");
  });
});
