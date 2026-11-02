import { describe, expect, it } from "vitest";
import { buildVersion } from "../../../src/core/compiler/build-version.js";
import { FakeFileSystem } from "../../fakes/fake-file-system.js";
import { FakeFlowStore } from "../../fakes/fake-flow-store.js";
import { FakeStore } from "../../fakes/fake-store.js";
import { flow, prompt, script, thenWire } from "../../fixtures/flow-builders.js";

const home = "/fd-home";

const setup = () => {
  const flows = new FakeFlowStore({ newId: () => "flow-1" });
  flows.save(flow([prompt("p1")], []));
  flows.save(flow([prompt("p1"), script("s1")], [thenWire("p1", "s1")]));
  return { flows, store: new FakeStore(), fs: new FakeFileSystem() };
};

describe("buildVersion", () => {
  it("builds the chosen version and records it with its flow version", async () => {
    const { flows, store, fs } = setup();

    const result = await buildVersion({ flowId: "flow-1", version: 1 }, { flows, store, fs, home });

    if (!result.ok) throw new Error("build failed");
    expect(store.builds()).toEqual([result.record]);
    expect(result.record.source).toEqual({ flowId: "flow-1", version: 1 });
    expect(result.record.nodes.map((node) => node.nodeId)).toEqual(["p1"]);
  });

  it("names only the flow and version in the build, whatever else the reference carries", async () => {
    const { flows, store, fs } = setup();
    const latest = flows.loadLatest();
    if (latest === null) throw new Error("nothing saved");

    const result = await buildVersion(latest, { flows, store, fs, home });

    if (!result.ok) throw new Error("build failed");
    expect(result.record.source).toEqual({ flowId: "flow-1", version: 2 });
    const manifest = JSON.parse(await fs.readFile(`${result.dir}/manifest.json`));
    expect(manifest.source).toEqual({ flowId: "flow-1", version: 2 });
  });

  it("gives each version its own build", async () => {
    const { flows, store, fs } = setup();

    await buildVersion({ flowId: "flow-1", version: 1 }, { flows, store, fs, home });
    await buildVersion({ flowId: "flow-1", version: 2 }, { flows, store, fs, home });

    expect(store.listBuilds().map((build) => build.source)).toEqual([
      { flowId: "flow-1", version: 2 },
      { flowId: "flow-1", version: 1 },
    ]);
  });

  it("refuses a version that was never saved, writing and recording nothing", async () => {
    const { flows, store, fs } = setup();

    const result = await buildVersion({ flowId: "flow-1", version: 9 }, { flows, store, fs, home });

    expect(result).toEqual({
      ok: false,
      errors: [{ rule: "version", message: "flow-1 has no saved version 9" }],
    });
    expect(store.builds()).toEqual([]);
    expect(fs.calls.filter((call) => call.method === "writeFile")).toEqual([]);
  });
});
