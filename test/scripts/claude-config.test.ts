import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claudeLeftovers, makeTempClaudeConfig } from "../../scripts/claude-config.js";

const projectFolderOf = (path: string) => path.replace(/[^a-zA-Z0-9]/g, "-");

describe("claude config helpers", () => {
  let home: string;
  let root: string;

  beforeEach(async () => {
    home = await realpath(await mkdtemp(join(tmpdir(), "fd-cc-home-")));
    root = await realpath(await mkdtemp(join(tmpdir(), "fd-cc-root-")));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  });

  const writeHomeFiles = async (settings: unknown, claudeJson: unknown) => {
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(join(home, ".claude", "settings.json"), JSON.stringify(settings));
    await writeFile(join(home, ".claude.json"), JSON.stringify(claudeJson));
  };

  describe("makeTempClaudeConfig", () => {
    it("copies settings.json and .claude.json into <root>/.claude and returns the env that points Claude at it", async () => {
      await writeHomeFiles({ model: "haiku" }, { userID: "u1" });

      const made = await makeTempClaudeConfig({ root, home });

      const configDir = join(root, ".claude");
      expect(made).toEqual({
        configDir,
        env: { CLAUDE_CONFIG_DIR: configDir, CLAUDE_SECURESTORAGE_CONFIG_DIR: "" },
      });
      expect(JSON.parse(await readFile(join(configDir, "settings.json"), "utf8"))).toEqual({
        model: "haiku",
      });
      expect(JSON.parse(await readFile(join(configDir, ".claude.json"), "utf8"))).toEqual({
        userID: "u1",
      });
    });

    it("applies the settings transform to the copied settings only", async () => {
      await writeHomeFiles({ model: "haiku", consent: true }, { userID: "u1" });

      const { configDir } = await makeTempClaudeConfig({
        root,
        home,
        settings: (settings) =>
          Object.fromEntries(Object.entries(settings).filter(([key]) => key !== "consent")),
      });

      expect(JSON.parse(await readFile(join(configDir, "settings.json"), "utf8"))).toEqual({
        model: "haiku",
      });
      expect(JSON.parse(await readFile(join(home, ".claude", "settings.json"), "utf8"))).toEqual({
        model: "haiku",
        consent: true,
      });
    });

    it("makes the folder and copies nothing when the home has neither file", async () => {
      const { configDir } = await makeTempClaudeConfig({ root, home });

      expect(existsSync(configDir)).toBe(true);
      expect(existsSync(join(configDir, "settings.json"))).toBe(false);
      expect(existsSync(join(configDir, ".claude.json"))).toBe(false);
    });

    it("fails when the home's settings.json exists but cannot be read", async () => {
      await mkdir(join(home, ".claude", "settings.json"), { recursive: true });

      await expect(makeTempClaudeConfig({ root, home })).rejects.toMatchObject({ code: "EISDIR" });
    });

    it("fails when the home's .claude.json exists but cannot be copied", async () => {
      await mkdir(join(home, ".claude.json"));

      await expect(makeTempClaudeConfig({ root, home })).rejects.toHaveProperty("code");
    });
  });

  describe("claudeLeftovers", () => {
    const projectsDir = () => join(home, ".claude", "projects");

    it("is empty when the home has no projects folder and no .claude.json", async () => {
      expect(await claudeLeftovers({ home, roots: [root] })).toEqual([]);
    });

    it("fails when the projects folder exists but cannot be listed", async () => {
      await mkdir(join(home, ".claude"), { recursive: true });
      await writeFile(projectsDir(), "");

      await expect(claudeLeftovers({ home, roots: [root] })).rejects.toMatchObject({
        code: "ENOTDIR",
      });
    });

    it("lists the project folders Claude made for the root and for paths under it", async () => {
      const own = projectFolderOf(root);
      const nested = projectFolderOf(join(root, "workspaces", "w1", "repo"));
      for (const name of [own, nested, "-Users-someone-elsewhere", `${own}x`]) {
        await mkdir(join(projectsDir(), name), { recursive: true });
      }

      expect((await claudeLeftovers({ home, roots: [root] })).sort()).toEqual(
        [join(projectsDir(), own), join(projectsDir(), nested)].sort(),
      );
    });

    it("lists every .claude.json key, at any depth, that contains a root", async () => {
      const work = join(root, "workspaces", "w1");
      await writeFile(
        join(home, ".claude.json"),
        JSON.stringify({
          userID: "u1",
          [root]: true,
          projects: { [work]: { allowedTools: [] }, "/Users/someone/elsewhere": {} },
          cache: { deeper: { [join(root, "x")]: 1 } },
        }),
      );

      const claudeJson = join(home, ".claude.json");
      expect((await claudeLeftovers({ home, roots: [root] })).sort()).toEqual(
        [root, work, join(root, "x")].map((key) => `${claudeJson}:${key}`).sort(),
      );
    });

    it("checks every root it is given", async () => {
      const other = await realpath(await mkdtemp(join(tmpdir(), "fd-cc-other-")));
      try {
        await mkdir(join(projectsDir(), projectFolderOf(other)), { recursive: true });
        await writeFile(join(home, ".claude.json"), JSON.stringify({ projects: { [other]: {} } }));

        expect(await claudeLeftovers({ home, roots: [root] })).toEqual([]);
        expect((await claudeLeftovers({ home, roots: [root, other] })).sort()).toEqual(
          [
            join(projectsDir(), projectFolderOf(other)),
            `${join(home, ".claude.json")}:${other}`,
          ].sort(),
        );
      } finally {
        await rm(other, { recursive: true, force: true });
      }
    });
  });
});
