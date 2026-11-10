import { describe, expect, it } from "vitest";
import { build } from "../../../src/core/compiler/build.js";
import { FakeConnectorSource } from "../../fakes/fake-connector-source.js";
import { FakeFileSystem } from "../../fakes/fake-file-system.js";
import { agent, onMainFlow } from "../../fixtures/flow-builders.js";

const home = "/fd-home";
const workspace = {
  id: "b1111111-0000-4000-8000-000000000001",
  name: "fix-login",
  repo: "/work/repo",
  base: "main",
  values: {},
};
const jira = { type: "http", url: "https://mcp.example.com/jira" };
const mocks = { type: "stdio", command: "npx", args: ["mock-server"], env: { PORT: "9" } };

const withConnectors = (connectors: string[]) => {
  const base = onMainFlow([agent("p1")], []);
  return { ...base, session: { ...base.session, connectors } };
};

describe("connectors in a build", () => {
  it("keeps only the connector names in the build: no mcp.json and no secret", async () => {
    const fs = new FakeFileSystem();
    const connectors = new FakeConnectorSource({ jira, mocks });

    const result = await build(withConnectors(["mocks", "jira"]), {
      fs,
      home,
      connectors,
      workspace,
    });

    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    const files = await fs.list(result.dir);
    expect(files).not.toContain("mcp.json");
    for (const path of files) {
      expect(await fs.readFile(`${result.dir}/${path}`), path).not.toContain("mock-server");
    }
    const manifest = JSON.parse(await fs.readFile(`${result.dir}/manifest.json`));
    expect(manifest.session.connectors).toEqual(["mocks", "jira"]);
  });

  it("builds the same hash whatever a connector's env holds", async () => {
    const withToken = (token: string) =>
      new FakeConnectorSource({ jira, mocks: { ...mocks, env: { TOKEN: token } } });
    const hashWith = async (token: string) => {
      const result = await build(withConnectors(["mocks"]), {
        fs: new FakeFileSystem(),
        home,
        connectors: withToken(token),
        workspace,
      });
      if (!result.ok) throw new Error(JSON.stringify(result.errors));
      return result.hash;
    };

    expect(await hashWith("one")).toBe(await hashWith("two"));
  });

  it("writes no mcp.json for a session with no connectors", async () => {
    const fs = new FakeFileSystem();

    const result = await build(withConnectors([]), { fs, home, workspace });

    if (!result.ok) throw new Error("build failed");
    expect(await fs.list(result.dir)).not.toContain("mcp.json");
  });

  it("refuses a connector Claude Code does not have, naming it, and writes nothing", async () => {
    const fs = new FakeFileSystem();
    const connectors = new FakeConnectorSource({ jira });

    const result = await build(withConnectors(["jira", "slack"]), {
      fs,
      home,
      connectors,
      workspace,
    });

    expect(result).toEqual({
      ok: false,
      errors: [
        {
          rule: "connectors",
          field: "connectors",
          message:
            'Connector "slack" is not set up in Claude Code. Add it for your user with `claude mcp add --scope user slack …`, then build again.',
        },
      ],
    });
    expect(fs.calls.filter((call) => call.method === "writeFile")).toEqual([]);
  });

  it("refuses every connector when nothing can look connectors up", async () => {
    const result = await build(withConnectors(["jira"]), {
      fs: new FakeFileSystem(),
      home,
      workspace,
    });

    expect(result.ok ? [] : result.errors.map((error) => error.message)).toEqual([
      expect.stringContaining('Connector "jira" is not set up'),
    ]);
  });
});
