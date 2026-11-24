import { describe, expect, it } from "vitest";
import {
  blueprintKind,
  expandLibraries,
  kindResolver,
  labelPrefix,
  LibraryError,
  LibraryLoopError,
  libraryLookup,
  type BlueprintKind,
  type LibraryResolver,
} from "../../../src/core/flow/libraries.js";
import { blueprintFacts } from "../../../src/core/flow/flow-store.js";
import { rule as sessionConnections } from "../../../src/core/compiler/rules/session-connections.js";
import { parseFlow, type Flow, type Node } from "../../../src/core/flow/schema.js";
import { fillVariables } from "../../../src/core/flow/variables.js";
import { FakeFlowStore } from "../../fakes/fake-flow-store.js";
import {
  agent,
  branch,
  flowSettings,
  onMainFlow,
  output,
  sessionContainer,
  thenWire,
  trigger,
  wire,
  workspaceContainer,
} from "../../fixtures/flow-builders.js";

const libraryNode = (
  id: string,
  libraryId: string,
  label: string,
  overrides: Record<string, Record<string, string>> = {},
) => ({
  id,
  label: "Library",
  position: { x: 0, y: 0 },
  type: "library",
  settings: { libraryId, label, overrides },
});

const plain = (
  nodes: unknown[],
  wires: unknown[],
  containers: unknown[] = [],
  settings: Record<string, unknown> = flowSettings,
): Flow => parseFlow({ nodes, wires, containers, settings });

const chain = (ids: string[]) =>
  ids.slice(1).map((id, index) => thenWire(ids[index] as string, id));

const nodeLibrary = (members: unknown[], path: string[], settings = flowSettings): Flow =>
  plain(
    [trigger("canvas-start"), ...members, output("canvas-stop")],
    chain(["canvas-start", ...path, "canvas-stop"]),
    [],
    settings,
  );

const sessionLibrary = (): Flow =>
  plain(
    [trigger("canvas-start"), trigger("s-start"), output("s-stop"), output("canvas-stop")],
    [
      wire("canvas-start", "out", "session-1", "flow-in"),
      thenWire("s-start", "s-stop"),
      wire("session-1", "flow-out", "canvas-stop", "in"),
    ],
    [
      sessionContainer(["s-start", "s-stop"], {
        name: "android",
        repo: "/repos/android",
        branch: "main",
      }),
    ],
  );

const connectedSessionLibrary = (): Flow =>
  parseFlow({
    nodes: [
      trigger("canvas-start"),
      trigger("a-start"),
      output("a-stop"),
      trigger("i-start"),
      output("i-stop"),
      output("canvas-stop"),
    ],
    wires: [
      wire("canvas-start", "out", "android", "flow-in"),
      thenWire("a-start", "a-stop"),
      wire("android", "flow-out", "ios", "flow-in"),
      thenWire("i-start", "i-stop"),
      wire("ios", "flow-out", "canvas-stop", "in"),
    ],
    containers: [
      sessionContainer(["a-start", "a-stop"], { id: "android", name: "android" }),
      sessionContainer(["i-start", "i-stop"], { id: "ios", name: "ios" }),
    ],
    settings: flowSettings,
    connections: [{ id: "link", between: ["android", "ios"] }],
  });

const resolverOf =
  (libraries: Record<string, Flow>): LibraryResolver =>
  (flowId) => {
    const flow = libraries[flowId];
    return flow === undefined ? undefined : { name: `${flowId} lib`, flow };
  };

const storeResolver =
  (store: FakeFlowStore): LibraryResolver =>
  (flowId) => {
    const loaded = store.loadLatest(flowId);
    return loaded === null ? undefined : { name: loaded.name, flow: loaded.flow };
  };

const loosePath = (member: unknown): Flow =>
  plain(
    [trigger("canvas-start"), trigger("w-start"), output("w-stop"), member, output("canvas-stop")],
    [
      wire("canvas-start", "out", "workspace-1", "flow-in"),
      thenWire("w-start", "w-stop"),
      wire("workspace-1", "flow-out", "use", "in"),
      wire("use", "out", "canvas-stop", "in"),
    ],
    [workspaceContainer(["w-start", "w-stop"])],
  );

const nodeById = (flow: Flow, id: string): Node | undefined =>
  flow.nodes.find((node) => node.id === id);

const instructionsOf = (flow: Flow, id: string): string | undefined => {
  const node = nodeById(flow, id);
  return node?.type === "agent" ? node.settings.instructions : undefined;
};

describe("labelPrefix", () => {
  it("lowercases the label and turns spaces into dashes", () => {
    expect(labelPrefix("Android App")).toBe("android-app");
  });
});

describe("blueprintKind", () => {
  it("is a node library for a plain path, whatever sits off it", () => {
    const library = plain(
      [
        trigger("canvas-start"),
        agent("a"),
        agent("b"),
        output("canvas-stop"),
        trigger("s-start"),
        output("s-stop"),
      ],
      [...chain(["canvas-start", "a", "b", "canvas-stop"]), thenWire("s-start", "s-stop")],
      [sessionContainer(["s-start", "s-stop"])],
    );

    expect(blueprintKind(library)).toBe("node-library");
  });

  it("is a session library for a path through a session container", () => {
    expect(blueprintKind(sessionLibrary())).toBe("session-library");
  });

  it.each([
    [
      "a canvas Start wired to nothing",
      plain([trigger("canvas-start"), output("canvas-stop")], []),
    ],
    ["no canvas Start", plain([agent("a"), output("canvas-stop")], [thenWire("a", "canvas-stop")])],
    [
      "a canvas Start that never reaches a canvas Stop",
      plain([trigger("canvas-start"), agent("a")], [thenWire("canvas-start", "a")]),
    ],
  ])("is incomplete with %s", (_, library) => {
    expect(blueprintKind(library)).toBe("incomplete");
  });

  it.each([
    ["wired", onMainFlow([agent("a")], [])],
    [
      "unwired",
      plain(
        [trigger("w-start"), output("w-stop")],
        [thenWire("w-start", "w-stop")],
        [workspaceContainer(["w-start", "w-stop"])],
      ),
    ],
  ])("is a workflow with a %s workspace", (_, flow) => {
    expect(blueprintKind(flow)).toBe("workflow");
  });

  it.each<[BlueprintKind, BlueprintKind]>([
    ["session-library", "session-library"],
    ["node-library", "node-library"],
  ])("reads a path through a %s node as a %s", (used, expected) => {
    const library = nodeLibrary([libraryNode("use", "other", "other")], ["use"]);

    expect(blueprintKind(library, () => used)).toBe(expected);
  });
});

describe("kindResolver", () => {
  it("reads a library through the libraries it uses", () => {
    const kindOf = kindResolver(
      resolverOf({
        outer: nodeLibrary([libraryNode("use", "sessions", "sessions")], ["use"]),
        sessions: sessionLibrary(),
      }),
    );

    expect(kindOf("outer")).toBe("session-library");
    expect(kindOf("missing")).toBeUndefined();
  });

  it("gives incomplete for a loop instead of recursing forever", () => {
    const kindOf = kindResolver(
      resolverOf({
        a: nodeLibrary([libraryNode("use-b", "b", "b")], ["use-b"]),
        b: nodeLibrary([libraryNode("use-a", "a", "a")], ["use-a"]),
      }),
    );

    expect(kindOf("a")).toBe("incomplete");
    expect(kindOf("b")).toBe("incomplete");
  });
});

describe("libraryLookup", () => {
  it("gives a library's name, kind and session containers", () => {
    const lookup = libraryLookup(resolverOf({ sessions: sessionLibrary() }));

    expect(lookup("sessions")).toEqual({
      name: "sessions lib",
      kind: "session-library",
      sessions: [
        {
          id: "session-1",
          name: "android",
          repo: "/repos/android",
          branch: "main",
          model: "sonnet",
        },
      ],
    });
    expect(lookup("missing")).toBeUndefined();
  });

  it("lists the sessions of the expanded library, under the ids its overrides use", () => {
    const lookup = libraryLookup(
      resolverOf({
        middle: nodeLibrary([libraryNode("use-inner", "sessions", "inner")], ["use-inner"]),
        sessions: sessionLibrary(),
      }),
    );

    expect(lookup("middle")?.sessions).toEqual([
      {
        id: "inner-session-1",
        name: "inner-android",
        repo: "/repos/android",
        branch: "main",
        model: "sonnet",
      },
    ]);
  });
});

describe("blueprintFacts", () => {
  it("reads a host whose library is missing as if it used none", () => {
    const facts = blueprintFacts(loosePath(libraryNode("use", "missing", "use")), () => undefined);

    expect(facts).toEqual({ kind: "workflow", variables: [], sessions: [] });
  });

  it("lets an error that is not a library error through", () => {
    const failing: LibraryResolver = () => {
      throw new Error("the store is closed");
    };

    expect(() => blueprintFacts(loosePath(libraryNode("use", "lib", "use")), failing)).toThrow(
      "the store is closed",
    );
  });
});

describe("expandLibraries", () => {
  it("splices a node library between the library node's wires inside its session", () => {
    const store = new FakeFlowStore();
    const { flowId } = store.save(nodeLibrary([agent("plan")], ["plan"]), { name: "Android" });
    const host = onMainFlow(
      [agent("own"), agent("android-app-plan"), libraryNode("use", flowId, "android-app")],
      [thenWire("own", "android-app-plan"), thenWire("android-app-plan", "use")],
    );
    const saved = structuredClone(host);

    const { flow } = expandLibraries(host, storeResolver(store));

    expect(flow.nodes.map((node) => node.id)).not.toContain("use");
    expect(nodeById(flow, "android-app-plan-2")?.type).toBe("agent");
    expect(flow.nodes.map((node) => node.id)).not.toContain("android-app-canvas-start");
    expect(flow.nodes.map((node) => node.id)).not.toContain("android-app-canvas-stop");
    expect(flow.wires).toContainEqual(thenWire("android-app-plan", "android-app-plan-2"));
    expect(flow.wires).toContainEqual(thenWire("android-app-plan-2", "stop"));
    expect(flow.wires.filter((each) => each.from.node === "use" || each.to.node === "use")).toEqual(
      [],
    );
    expect(flow.containers.find((container) => container.id === "session-1")?.nodes).toContain(
      "android-app-plan-2",
    );
    expect(host).toEqual(saved);
  });

  it("expands from the library's latest saved version", () => {
    const store = new FakeFlowStore();
    const { flowId } = store.save(nodeLibrary([agent("plan")], ["plan"]), { name: "Android" });
    store.save(nodeLibrary([{ ...agent("plan"), label: "Write the plan" }], ["plan"]), flowId);
    const host = onMainFlow([libraryNode("use", flowId, "android-app")], []);

    const { flow } = expandLibraries(host, storeResolver(store));

    expect(nodeById(flow, "android-app-plan")?.label).toBe("Write the plan");
  });

  it("prefixes variables by every library label on the way down, top first", () => {
    const store = new FakeFlowStore();
    const tests = store.save(nodeLibrary([branch("full", "isFullScan")], ["full"]), {
      name: "E2E tests",
    });
    const android = store.save(
      nodeLibrary([libraryNode("use-tests", tests.flowId, "e2e-tests")], ["use-tests"]),
      { name: "Android" },
    );
    const host = onMainFlow(
      [
        agent("own", { settings: { instructions: "Fix {{ticket}}" } }),
        libraryNode("use", android.flowId, "android-app"),
      ],
      [thenWire("own", "use")],
    );

    const { flow, uses } = expandLibraries(host, storeResolver(store));

    const expanded = nodeById(flow, "android-app-e2e-tests-full");
    expect(expanded?.type === "branch" && expanded.settings.variable).toBe(
      "android-app.e2e-tests.isFullScan",
    );
    expect(instructionsOf(flow, "own")).toBe("Fix {{ticket}}");
    expect(uses).toEqual([
      { path: "android-app", name: "Android", kind: "node-library" },
      { path: "android-app.e2e-tests", name: "E2E tests", kind: "node-library" },
    ]);
  });

  it("gives each copy of one library its own variables", () => {
    const store = new FakeFlowStore();
    const { flowId } = store.save(
      nodeLibrary([agent("ship", { settings: { instructions: "Ship {{ticket}}" } })], ["ship"]),
      { name: "Android" },
    );
    const host = onMainFlow(
      [libraryNode("one", flowId, "android-app"), libraryNode("two", flowId, "android-app-2")],
      [thenWire("one", "two")],
    );

    const { flow } = expandLibraries(host, storeResolver(store));
    const values = { "android-app.ticket": "A-1", "android-app-2.ticket": "A-2" };

    expect(instructionsOf(flow, "android-app-ship")).toBe("Ship {{android-app.ticket}}");
    expect(fillVariables(instructionsOf(flow, "android-app-ship") ?? "", values)).toBe("Ship A-1");
    expect(fillVariables(instructionsOf(flow, "android-app-2-ship") ?? "", values)).toBe(
      "Ship A-2",
    );
  });

  it("puts a session library's sessions on the override, leaving the library untouched", () => {
    const resolved = { name: "Android sessions", flow: sessionLibrary() };
    const before = structuredClone(resolved);
    const resolve: LibraryResolver = () => resolved;

    const overridden = expandLibraries(
      loosePath(
        libraryNode("use", "sessions", "sessions", { "session-1": { branch: "feature/x" } }),
      ),
      resolve,
    ).flow;
    const plainUse = expandLibraries(
      loosePath(libraryNode("use", "sessions", "sessions")),
      resolve,
    ).flow;

    expect(overridden.containers).toContainEqual({
      id: "sessions-session-1",
      kind: "session",
      name: "sessions-android",
      repo: "/repos/android",
      branch: "feature/x",
      model: "sonnet",
      nodes: ["sessions-s-start", "sessions-s-stop"],
    });
    expect(overridden.wires).toContainEqual(
      wire("workspace-1", "flow-out", "sessions-session-1", "flow-in"),
    );
    expect(overridden.wires).toContainEqual(
      wire("sessions-session-1", "flow-out", "canvas-stop", "in"),
    );
    expect(resolved).toEqual(before);
    expect(
      plainUse.containers.find((container) => container.id === "sessions-session-1"),
    ).toMatchObject({ branch: "main" });
  });

  it("carries a session library's connections onto its renamed sessions, once per use", () => {
    const resolve = resolverOf({ apps: connectedSessionLibrary() });
    const once = expandLibraries(loosePath(libraryNode("use", "apps", "apps")), resolve).flow;
    const twice = expandLibraries(
      parseFlow({
        nodes: [
          trigger("canvas-start"),
          trigger("w-start"),
          output("w-stop"),
          libraryNode("one", "apps", "one"),
          libraryNode("two", "apps", "two"),
          output("canvas-stop"),
        ],
        wires: [
          wire("canvas-start", "out", "workspace-1", "flow-in"),
          thenWire("w-start", "w-stop"),
          wire("workspace-1", "flow-out", "one", "in"),
          wire("one", "out", "two", "in"),
          wire("two", "out", "canvas-stop", "in"),
        ],
        containers: [workspaceContainer(["w-start", "w-stop"])],
        settings: flowSettings,
        connections: [{ id: "one-link", between: ["one-android", "two-ios"] }],
      }),
      resolve,
    ).flow;

    expect(once.connections).toEqual([{ id: "apps-link", between: ["apps-android", "apps-ios"] }]);
    expect(twice.connections).toEqual([
      { id: "one-link", between: ["one-android", "two-ios"] },
      { id: "one-link-2", between: ["one-android", "one-ios"] },
      { id: "two-link", between: ["two-android", "two-ios"] },
    ]);
    expect(sessionConnections.check(once)).toEqual([]);
    expect(sessionConnections.check(twice)).toEqual([]);
  });

  it("keeps the host's settings, not the library's", () => {
    const resolve = resolverOf({
      lib: nodeLibrary([agent("plan")], ["plan"], { buildModel: "opus", permissionMode: "plan" }),
    });
    const host = onMainFlow([libraryNode("use", "lib", "lib")], []);

    expect(expandLibraries(host, resolve).flow.settings).toEqual(flowSettings);
  });

  it("leaves a library node off the main flow as it is", () => {
    const resolve = resolverOf({ lib: nodeLibrary([agent("plan")], ["plan"]) });
    const host = onMainFlow([libraryNode("use", "lib", "lib")], []);
    const stray = parseFlow({
      ...host,
      nodes: [...host.nodes, libraryNode("stray", "nowhere", "stray")],
      containers: host.containers.map((container) =>
        container.id === "session-1"
          ? { ...container, nodes: [...container.nodes, "stray"] }
          : container,
      ),
    });

    const { flow } = expandLibraries(stray, resolve);

    expect(nodeById(flow, "stray")).toEqual(nodeById(stray, "stray"));
    expect(nodeById(flow, "lib-plan")?.type).toBe("agent");
  });

  it("builds a session library left unwired in a workflow, as the workspace starts its sessions", () => {
    const resolve = resolverOf({ sessions: sessionLibrary() });
    const host = plain(
      [
        trigger("canvas-start"),
        trigger("w-start"),
        output("w-stop"),
        libraryNode("use", "sessions", "sessions"),
        output("canvas-stop"),
      ],
      [
        wire("canvas-start", "out", "workspace-1", "flow-in"),
        thenWire("w-start", "w-stop"),
        wire("workspace-1", "flow-out", "canvas-stop", "in"),
      ],
      [workspaceContainer(["w-start", "w-stop"])],
    );

    const { flow, uses } = expandLibraries(host, resolve);

    expect(flow.containers.map((container) => container.id)).toContain("sessions-session-1");
    expect(uses).toEqual([{ path: "sessions", name: "sessions lib", kind: "session-library" }]);
  });

  it("leaves a session library unwired on a library's canvas as it is", () => {
    const resolve = resolverOf({ sessions: sessionLibrary() });
    const host = plain(
      [
        trigger("canvas-start"),
        agent("plan"),
        libraryNode("use", "sessions", "sessions"),
        output("canvas-stop"),
      ],
      chain(["canvas-start", "plan", "canvas-stop"]),
    );

    const { flow } = expandLibraries(host, resolve);

    expect(nodeById(flow, "use")).toEqual(nodeById(host, "use"));
    expect(flow.containers).toEqual([]);
  });

  it("gives a nested session library the overrides of the library node that names it", () => {
    const resolve = resolverOf({
      middle: nodeLibrary(
        [libraryNode("use-inner", "sessions", "inner", { "session-1": { branch: "middle" } })],
        ["use-inner"],
      ),
      sessions: sessionLibrary(),
    });
    const host = loosePath(
      libraryNode("use", "middle", "outer", { "session-1": { branch: "host" } }),
    );

    const { flow, uses } = expandLibraries(host, resolve);

    expect(
      flow.containers.find((container) => container.id === "outer-inner-session-1"),
    ).toMatchObject({ name: "outer-inner-android", branch: "middle" });
    expect(uses).toEqual([
      { path: "outer", name: "middle lib", kind: "session-library" },
      { path: "outer.inner", name: "sessions lib", kind: "session-library" },
    ]);
  });

  it("stops a library that uses itself again", () => {
    const resolve = resolverOf({
      a: nodeLibrary([libraryNode("use-b", "b", "b")], ["use-b"]),
      b: nodeLibrary([libraryNode("use-a", "a", "a")], ["use-a"]),
    });
    const host = onMainFlow([libraryNode("use", "a", "a")], []);

    expect(() => expandLibraries(host, resolve)).toThrow(LibraryLoopError);
    expect(() => expandLibraries(host, resolve)).toThrow("a uses a library that uses it again");
  });

  it.each([
    ["missing", {}],
    ["incomplete", { lib: plain([agent("a")], []) }],
  ])("refuses a %s library", (_, libraries) => {
    const host = onMainFlow([libraryNode("use", "lib", "lib")], []);

    expect(() => expandLibraries(host, resolverOf(libraries))).toThrow(LibraryError);
  });
});
