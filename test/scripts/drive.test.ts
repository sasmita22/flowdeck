import { _electron, type Page } from "@playwright/test";
import type * as Electron from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import {
  drive,
  forceExit,
  launchApp,
  openCanvas,
  parseSteps,
  playwrightPage,
  reportFailure,
  resolveHome,
  runSteps,
  type DriveApp,
  type DrivePage,
} from "../../scripts/drive.js";

class FakeDrivePage implements DrivePage {
  failOn: string | undefined;

  constructor(
    readonly calls: string[] = [],
    private readonly prefix = "",
  ) {}

  private act(call: string): Promise<void> {
    this.calls.push(`${this.prefix}${call}`);
    if (call === this.failOn) return Promise.reject(new Error(`${call} failed`));
    return Promise.resolve();
  }

  click(testid: string): Promise<void> {
    return this.act(`click ${testid}`);
  }

  type(testid: string, text: string): Promise<void> {
    return this.act(`type ${testid} ${text}`);
  }

  waitForText(text: string, timeoutMs: number): Promise<void> {
    return this.act(`wait ${text} ${timeoutMs}`);
  }

  drag(from: string, to: string, toPosition?: { x: number; y: number }): Promise<void> {
    const at = toPosition === undefined ? "centre" : `${toPosition.x},${toPosition.y}`;
    return this.act(`drag ${from} ${to} ${at}`);
  }

  press(key: string): Promise<void> {
    return this.act(`press ${key}`);
  }

  rightClick(testid: string): Promise<void> {
    return this.act(`right-click ${testid}`);
  }

  clickAt(testid: string, position: { x: number; y: number }): Promise<void> {
    return this.act(`click-at ${testid} ${position.x},${position.y}`);
  }

  select(testid: string, option: { value: string } | { label: string }): Promise<void> {
    const chosen = "value" in option ? `value=${option.value}` : `label=${option.label}`;
    return this.act(`select ${testid} ${chosen}`);
  }

  waitFor(testid: string, timeoutMs: number): Promise<void> {
    return this.act(`wait-for ${testid} ${timeoutMs}`);
  }

  async screenshot(path: string): Promise<void> {
    await this.act(`screenshot`);
    await writeFile(path, "png");
  }

  ariaSnapshot(): Promise<string> {
    return Promise.resolve('- heading "Flowdeck" [level=1]\n');
  }
}

function windowOf(app: FakeApp): Page {
  const closed = () => once(app.proc, "exit");
  const prompt = {
    or: () => prompt,
    waitFor: () =>
      app.closePrompts
        ? Promise.resolve()
        : closed().then(() => Promise.reject(new Error("target closed"))),
  };
  return {
    getByText: () => ({
      first: () => ({ waitFor: () => Promise.reject(new Error("never shown")) }),
    }),
    getByTestId: (testid: string) => ({
      ...prompt,
      click: () => {
        app.clicks.push(testid);
        return Promise.resolve();
      },
    }),
    isClosed: () => app.proc.exitCode !== null,
    waitForEvent: () => closed(),
  } as unknown as Page;
}

const standIns: ChildProcess[] = [];

const isAlive = (target: number) => {
  try {
    process.kill(target, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
};

afterEach(async () => {
  await Promise.all(
    standIns.splice(0).map(async (child) => {
      const exited = child.exitCode !== null || child.signalCode !== null;
      const exit = exited ? undefined : once(child, "exit");
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
      await exit;
    }),
  );
});

class FakeProcess extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  private child: ChildProcess | undefined;

  constructor(
    readonly stdout: PassThrough,
    readonly stderr: PassThrough,
  ) {
    super();
  }

  get pid(): number | undefined {
    return this.standIn().pid;
  }

  standIn(script = "setTimeout(() => {}, 60_000);"): ChildProcess {
    if (!this.child) {
      this.child = spawn(process.execPath, ["-e", script], {
        detached: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
      standIns.push(this.child);
    }
    return this.child;
  }
}

class FakeApp implements DriveApp {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly proc = new FakeProcess(this.stdout, this.stderr);
  closeCalls = 0;
  evaluateCalls = 0;
  enginePids: number[] = [];
  windowError: Error | undefined;
  closeError: Error | undefined;
  evaluateError: Error | undefined;
  closePrompts = false;
  clicks: string[] = [];

  process() {
    return this.proc;
  }

  evaluate<R>(): Promise<R> {
    this.evaluateCalls += 1;
    if (this.evaluateError) return Promise.reject(this.evaluateError);
    setTimeout(() => {
      if (this.proc.exitCode !== null) return;
      this.proc.exitCode = 0;
      this.proc.emit("exit", 0, null);
    }, 0);
    return Promise.resolve(this.enginePids as R);
  }

  firstWindow(): Promise<Page> {
    if (this.windowError) return Promise.reject(this.windowError);
    return Promise.resolve(windowOf(this));
  }

  close(): Promise<void> {
    this.closeCalls += 1;
    if (this.closeError) return Promise.reject(this.closeError);
    return Promise.resolve();
  }
}

describe("parseSteps", () => {
  it("accepts click, type, wait-for-text and screenshot steps", () => {
    const steps = [
      { type: "click", testid: "a" },
      { type: "type", testid: "b", text: "hi" },
      { type: "wait-for-text", text: "Flowdeck", timeoutMs: 500 },
      { type: "wait-for-text", text: "ready" },
      { type: "screenshot" },
    ];

    expect(parseSteps(JSON.stringify(steps))).toEqual(steps);
  });

  it("accepts a right-click step and names one that has no testid", () => {
    const steps = [{ type: "right-click", testid: "loop-1" }];

    const parseWithoutTestid = () => parseSteps('[{"type":"screenshot"},{"type":"right-click"}]');

    expect(parseSteps(JSON.stringify(steps))).toEqual(steps);
    expect(parseWithoutTestid).toThrow("step 2 (right-click)");
    expect(parseWithoutTestid).toThrow("testid");
    expect(parseWithoutTestid).not.toThrow("unknown step type");
  });

  it("rejects malformed JSON", () => {
    expect(() => parseSteps("[{")).toThrow("steps.json is not valid JSON");
  });

  it("names an unknown step by its 1-based index and type", () => {
    expect(() => parseSteps('[{"type":"screenshot"},{"type":"fly"}]')).toThrow("step 2 (fly)");
  });

  it("names a click step that has no testid", () => {
    expect(() => parseSteps('[{"type":"click"}]')).toThrow("step 1 (click)");
  });

  it("accepts drag steps with and without a drop position, and press steps", () => {
    const steps = [
      { type: "drag", from: "palette-agent", to: "canvas", toPosition: { x: 200, y: 150 } },
      { type: "drag", from: "agent-1-out", to: "gate-1-in" },
      { type: "press", key: "Meta+z" },
    ];

    expect(parseSteps(JSON.stringify(steps))).toEqual(steps);
  });

  it.each([
    ["a drag without to", { type: "drag", from: "palette-agent" }, "drag", "→ at to"],
    [
      "a drag with a non-numeric toPosition",
      { type: "drag", from: "palette-agent", to: "canvas", toPosition: { x: "200", y: 150 } },
      "drag",
      "→ at toPosition.x",
    ],
    ["a press without key", { type: "press" }, "press", "→ at key"],
  ])("rejects %s, naming the step and the field", (_, step, type, field) => {
    const parse = () => parseSteps(JSON.stringify([{ type: "screenshot" }, step]));

    expect(parse).toThrow(`step 2 (${type})`);
    expect(parse).toThrow(field);
    expect(parse).not.toThrow("unknown step type");
  });

  it("accepts close-window and relaunch steps alongside the other step types", () => {
    const steps = [
      { type: "drag", from: "palette-agent", to: "canvas" },
      { type: "close-window" },
      { type: "click", testid: "close-save" },
      { type: "relaunch" },
      { type: "wait-for-text", text: "Untitled" },
      { type: "press", key: "Meta+s" },
      { type: "type", testid: "b", text: "hi" },
      { type: "screenshot" },
    ];

    expect(parseSteps(JSON.stringify(steps))).toEqual(steps);
  });

  it.each([
    ["close-window", "testid"],
    ["relaunch", "home"],
  ])("rejects an extra key on a %s step, naming the step and the key", (type, key) => {
    const parse = () => parseSteps(JSON.stringify([{ type: "screenshot" }, { type, [key]: "x" }]));

    expect(parse).toThrow(`step 2 (${type})`);
    expect(parse).toThrow(key);
    expect(parse).not.toThrow("unknown step type");
  });

  it("accepts resize-window and pause steps alongside the other step types", () => {
    const steps = [
      { type: "click", testid: "run" },
      { type: "resize-window", width: 1200, height: 800 },
      { type: "pause", ms: 2000 },
      { type: "pause", ms: 60_000 },
      { type: "screenshot" },
    ];

    expect(parseSteps(JSON.stringify(steps))).toEqual(steps);
  });

  it.each([
    [
      "an extra key on resize-window",
      { type: "resize-window", width: 1200, height: 800, x: 1 },
      "x",
    ],
    ["an extra key on pause", { type: "pause", ms: 1, until: "done" }, "until"],
    ["a zero width", { type: "resize-window", width: 0, height: 800 }, "width"],
    ["a negative height", { type: "resize-window", width: 1200, height: -1 }, "height"],
    ["a fractional width", { type: "resize-window", width: 1200.5, height: 800 }, "width"],
    ["a string height", { type: "resize-window", width: 1200, height: "800" }, "height"],
    ["a missing height", { type: "resize-window", width: 1200 }, "height"],
    ["a pause above 60000 ms", { type: "pause", ms: 60_001 }, "ms"],
    ["a zero pause", { type: "pause", ms: 0 }, "ms"],
    ["a fractional pause", { type: "pause", ms: 1.5 }, "ms"],
    ["a pause without ms", { type: "pause" }, "ms"],
  ])("rejects %s, naming the step and the field", (_, step, field) => {
    const parse = () => parseSteps(JSON.stringify([{ type: "screenshot" }, step]));

    expect(parse).toThrow(`step 2 (${step.type})`);
    expect(parse).toThrow(field);
    expect(parse).not.toThrow("unknown step type");
  });

  it("accepts click-at steps and select steps by value, by label and by an empty value", () => {
    const steps = [
      { type: "click-at", testid: "container-frame-session-1", position: { x: 6, y: 6 } },
      { type: "select", testid: "container-session-1-model", value: "haiku" },
      { type: "select", testid: "container-session-1-model", label: "Haiku (latest)" },
      { type: "select", testid: "runs-build-filter", value: "" },
    ];

    expect(parseSteps(JSON.stringify(steps))).toEqual(steps);
  });

  it.each([
    [
      "a negative coordinate",
      { type: "click-at", testid: "canvas", position: { x: -1, y: 6 } },
      "position.x",
    ],
    ["a missing position", { type: "click-at", testid: "canvas" }, "position"],
    [
      "an extra key inside position",
      { type: "click-at", testid: "canvas", position: { x: 6, y: 6, z: 1 } },
      'Unrecognized key: "z"',
    ],
  ])("rejects a click-at step with %s, naming the step", (_, step, field) => {
    const parse = () => parseSteps(JSON.stringify([{ type: "screenshot" }, step]));

    expect(parse).toThrow("(click-at):");
    expect(parse).toThrow(field);
    expect(parse).not.toThrow("unknown step type");
  });

  it.each([
    ["both value and label", { type: "select", testid: "m", value: "haiku", label: "Haiku" }],
    ["neither value nor label", { type: "select", testid: "m" }],
  ])("rejects a select step with %s", (_, step) => {
    const parse = () => parseSteps(JSON.stringify([step]));

    expect(parse).toThrow("step 1 (select):");
    expect(parse).toThrow("give exactly one of value or label");
  });

  it.each([
    ["no testid", { type: "select", value: "haiku" }, "testid"],
    ["a non-string value", { type: "select", testid: "m", value: 5 }, "value"],
  ])("rejects a select step with %s, naming the field", (_, step, field) => {
    const parse = () => parseSteps(JSON.stringify([step]));

    expect(parse).toThrow("step 1 (select):");
    expect(parse).toThrow(field);
    expect(parse).not.toThrow("give exactly one");
  });

  it("rejects a click step with a position key, naming the key", () => {
    const parse = () =>
      parseSteps(
        JSON.stringify([
          { type: "screenshot" },
          { type: "click", testid: "canvas", position: { x: 6, y: 6 } },
        ]),
      );

    expect(parse).toThrow("step 2 (click)");
    expect(parse).toThrow('Unrecognized key: "position"');
    expect(parse).not.toThrow("unknown step type");
  });

  it.each([
    ["right-click", { testid: "a" }],
    ["type", { testid: "a", text: "hi" }],
    ["wait-for-text", { text: "ready" }],
    ["screenshot", {}],
    ["drag", { from: "palette-agent", to: "canvas" }],
    ["press", { key: "Meta+z" }],
    ["click-at", { testid: "canvas", position: { x: 6, y: 6 } }],
    ["select", { testid: "m", value: "haiku" }],
  ])("rejects an extra key on a %s step, naming the step and the key", (type, fields) => {
    const parse = () =>
      parseSteps(JSON.stringify([{ type: "screenshot" }, { type, ...fields, bogus: 1 }]));

    expect(parse).toThrow(`step 2 (${type})`);
    expect(parse).toThrow('Unrecognized key: "bogus"');
    expect(parse).not.toThrow("unknown step type");
  });

  it("rejects an extra key inside a drag toPosition, naming the key", () => {
    const parse = () =>
      parseSteps(
        JSON.stringify([
          { type: "screenshot" },
          { type: "drag", from: "palette-agent", to: "canvas", toPosition: { x: 1, y: 1, z: 1 } },
        ]),
      );

    expect(parse).toThrow("step 2 (drag)");
    expect(parse).toThrow('Unrecognized key: "z"');
    expect(parse).not.toThrow("unknown step type");
  });
});

describe("runSteps", () => {
  let outDir: string;
  let page: FakeDrivePage;

  beforeEach(async () => {
    outDir = await mkdtemp(join(tmpdir(), "fd-drive-"));
    page = new FakeDrivePage();
  });

  afterEach(async () => {
    await rm(outDir, { recursive: true, force: true });
  });

  it("dispatches click, type and wait-for-text to the page by testid and text", async () => {
    await runSteps(
      [
        { type: "click", testid: "go" },
        { type: "type", testid: "name", text: "flow" },
        { type: "wait-for-text", text: "Flowdeck" },
        { type: "wait-for-text", text: "ready", timeoutMs: 250 },
      ],
      page,
      { outDir },
    );

    expect(page.calls).toEqual([
      "click go",
      "type name flow",
      "wait Flowdeck 10000",
      "wait ready 250",
    ]);
  });

  it("sends a right-click step to the page by testid, in step order", async () => {
    await runSteps(
      parseSteps(
        JSON.stringify([
          { type: "right-click", testid: "loop-1" },
          { type: "click", testid: "node-menu-frame-only" },
        ]),
      ),
      page,
      { outDir },
    );

    expect(page.calls).toEqual(["right-click loop-1", "click node-menu-frame-only"]);
  });

  it("dispatches drag and press to the page in step order", async () => {
    await runSteps(
      [
        { type: "drag", from: "palette-agent", to: "canvas", toPosition: { x: 200, y: 150 } },
        { type: "click", testid: "canvas-undo" },
        { type: "drag", from: "agent-1-out", to: "gate-1-in" },
        { type: "press", key: "Meta+z" },
        { type: "press", key: "Shift+Meta+z" },
      ],
      page,
      { outDir },
    );

    expect(page.calls).toEqual([
      "drag palette-agent canvas 200,150",
      "click canvas-undo",
      "drag agent-1-out gate-1-in centre",
      "press Meta+z",
      "press Shift+Meta+z",
    ]);
  });

  it("dispatches a click-at step to the page with its testid and position", async () => {
    await runSteps(
      parseSteps(
        JSON.stringify([
          { type: "click-at", testid: "container-frame-session-1", position: { x: 6, y: 6 } },
        ]),
      ),
      page,
      { outDir },
    );

    expect(page.calls).toEqual(["click-at container-frame-session-1 6,6"]);
  });

  it.each([
    [{ value: "haiku" }, "select container-session-1-model value=haiku"],
    [{ label: "Haiku (latest)" }, "select container-session-1-model label=Haiku (latest)"],
  ])("dispatches a select step by %o to the page", async (option, call) => {
    await runSteps(
      parseSteps(
        JSON.stringify([{ type: "select", testid: "container-session-1-model", ...option }]),
      ),
      page,
      { outDir },
    );

    expect(page.calls).toEqual([call]);
  });

  it("saves evidence only for screenshot steps when drag and press steps run", async () => {
    await runSteps(
      [
        { type: "drag", from: "palette-gate", to: "canvas", toPosition: { x: 10, y: 20 } },
        { type: "press", key: "Delete" },
        { type: "screenshot" },
      ],
      page,
      { outDir },
    );

    expect(page.calls).toEqual(["drag palette-gate canvas 10,20", "press Delete", "screenshot"]);
    expect((await readdir(outDir)).sort()).toEqual(["step-3.aria.yml", "step-3.png"]);
  });

  it("stops at a failing drag and names it by index and type", async () => {
    page.failOn = "drag palette-agent nowhere centre";

    await expect(
      runSteps(
        [
          { type: "drag", from: "palette-agent", to: "nowhere" },
          { type: "press", key: "Meta+z" },
        ],
        page,
        { outDir },
      ),
    ).rejects.toThrow("step 1 (drag)");
    expect(page.calls).not.toContain("press Meta+z");
  });

  it("writes exactly one png and one aria snapshot per screenshot step, named by step", async () => {
    await runSteps([{ type: "wait-for-text", text: "Flowdeck" }, { type: "screenshot" }], page, {
      outDir,
    });

    expect((await readdir(outDir)).sort()).toEqual(["step-2.aria.yml", "step-2.png"]);
    expect(await readFile(join(outDir, "step-2.aria.yml"), "utf8")).toContain("Flowdeck");
  });

  it("stops at a failing click and names it by index and type", async () => {
    page.failOn = "click missing";

    await expect(
      runSteps(
        [
          { type: "wait-for-text", text: "Flowdeck" },
          { type: "click", testid: "missing" },
          { type: "screenshot" },
        ],
        page,
        { outDir },
      ),
    ).rejects.toThrow("step 2 (click)");
    expect(page.calls).not.toContain("screenshot");
  });

  it("stops at a wait that times out and names it by index and type", async () => {
    page.failOn = "wait never 10000";

    await expect(
      runSteps(
        [
          { type: "wait-for-text", text: "never" },
          { type: "click", testid: "after" },
        ],
        page,
        { outDir },
      ),
    ).rejects.toThrow("step 1 (wait-for-text)");
    expect(page.calls).not.toContain("click after");
  });

  describe("close-window, relaunch and resize-window", () => {
    let calls: string[];
    let relaunched: FakeDrivePage;
    let relaunchError: Error | undefined;
    let windowCloses: boolean;
    const app = {
      closeWindow: () => {
        calls.push("close-window");
        return Promise.resolve(windowCloses);
      },
      relaunch: () => {
        calls.push("relaunch");
        if (relaunchError) return Promise.reject(relaunchError);
        return Promise.resolve<DrivePage>(relaunched);
      },
      resizeWindow: (width: number, height: number) => {
        calls.push(`resize ${width}x${height}`);
        return Promise.resolve();
      },
    };

    beforeEach(() => {
      calls = [];
      page = new FakeDrivePage(calls);
      relaunched = new FakeDrivePage(calls, "2:");
      relaunchError = undefined;
      windowCloses = true;
    });

    it("a click after close-window works while the window is still open", async () => {
      windowCloses = false;

      await runSteps(
        [{ type: "close-window" }, { type: "screenshot" }, { type: "click", testid: "close-save" }],
        page,
        { outDir, app },
      );

      expect(calls).toEqual(["close-window", "screenshot", "click close-save"]);
      expect((await readdir(outDir)).sort()).toEqual(["step-2.aria.yml", "step-2.png"]);
    });

    it("dispatches them to the app in step order and runs later steps on the new window", async () => {
      await runSteps(
        [
          { type: "click", testid: "a" },
          { type: "close-window" },
          { type: "relaunch" },
          { type: "click", testid: "b" },
          { type: "screenshot" },
        ],
        page,
        { outDir, app },
      );

      expect(calls).toEqual(["click a", "close-window", "relaunch", "2:click b", "2:screenshot"]);
      expect((await readdir(outDir)).sort()).toEqual(["step-5.aria.yml", "step-5.png"]);
    });

    it.each([
      ["click", { type: "click", testid: "x" } as const, "click x"],
      ["screenshot", { type: "screenshot" } as const, "screenshot"],
    ])(
      "fails a %s step after close-window closed the window and no relaunch followed, naming the step",
      async (type, step, call) => {
        const run = runSteps([{ type: "close-window" }, step], page, { outDir, app });

        await expect(run).rejects.toThrow(`step 2 (${type})`);
        await expect(run).rejects.toThrow("relaunch");
        expect(calls).not.toContain(call);
        expect(await readdir(outDir)).toEqual([]);
      },
    );

    it("names a relaunch that fails and runs nothing after it", async () => {
      relaunchError = new Error("launch failed");

      await expect(
        runSteps([{ type: "relaunch" }, { type: "click", testid: "b" }], page, { outDir, app }),
      ).rejects.toThrow("step 1 (relaunch): launch failed");
      expect(calls).toEqual(["relaunch"]);
    });

    it.each([["close-window"], ["relaunch"]] as const)(
      "fails a %s step when no app is given, naming the step",
      async (type) => {
        await expect(runSteps([{ type }], page, { outDir })).rejects.toThrow(`step 1 (${type})`);
        expect(calls).toEqual([]);
      },
    );

    it("sends resize-window steps to the app with their size, in step order", async () => {
      await runSteps(
        [
          { type: "click", testid: "a" },
          { type: "resize-window", width: 1200, height: 800 },
          { type: "click", testid: "b" },
          { type: "resize-window", width: 900, height: 600 },
        ],
        page,
        { outDir, app },
      );

      expect(calls).toEqual(["click a", "resize 1200x800", "click b", "resize 900x600"]);
    });

    it("fails a resize-window step when no app is given, naming the step", async () => {
      await expect(
        runSteps([{ type: "resize-window", width: 1200, height: 800 }], page, { outDir }),
      ).rejects.toThrow("step 1 (resize-window)");
      expect(calls).toEqual([]);
    });
  });

  it("does not run the step after a pause until its ms have elapsed", async () => {
    const pauseMs = 200;
    const startedAt: Record<string, number> = {};
    page.click = (testid: string) => {
      startedAt[testid] = performance.now();
      return Promise.resolve();
    };

    await runSteps(
      [
        { type: "click", testid: "before" },
        { type: "pause", ms: pauseMs },
        { type: "click", testid: "after" },
      ],
      page,
      { outDir },
    );

    expect(Object.keys(startedAt)).toEqual(["before", "after"]);
    expect((startedAt.after ?? 0) - (startedAt.before ?? 0)).toBeGreaterThanOrEqual(pauseMs - 5);
  });
});

type Box = { x: number; y: number; width: number; height: number };

class FakePlaywrightPage {
  readonly calls: string[] = [];
  scrollY = 0;

  constructor(
    private readonly boxes: Record<string, Box | null>,
    private readonly viewportHeight: number,
    private readonly optionReads: Record<string, { value: string; label: string }[][]> = {},
  ) {}

  readonly mouse = {
    move: (x: number, y: number, options?: { steps?: number }) => {
      this.calls.push(
        `move ${x},${y}${options?.steps === undefined ? "" : ` steps ${options.steps}`}`,
      );
      return Promise.resolve();
    },
    down: () => {
      this.calls.push("down");
      return Promise.resolve();
    },
    up: () => {
      this.calls.push("up");
      return Promise.resolve();
    },
  };

  readonly keyboard = {
    press: (key: string) => {
      this.calls.push(`press ${key}`);
      return Promise.resolve();
    },
  };

  getByTestId(testid: string) {
    const box = this.boxes[testid] ?? null;
    return {
      scrollIntoViewIfNeeded: () => {
        if (box !== null && box.y + box.height > this.scrollY + this.viewportHeight) {
          this.scrollY = Math.floor(box.y);
        }
        return Promise.resolve();
      },
      boundingBox: () => Promise.resolve(box === null ? null : { ...box, y: box.y - this.scrollY }),
      click: (options?: unknown) => {
        this.calls.push(`click ${testid} ${JSON.stringify(options)}`);
        return Promise.resolve();
      },
      waitFor: () => {
        this.calls.push(`wait-for ${testid}`);
        return Promise.resolve();
      },
      locator: (selector: string) => ({
        evaluateAll: <R>(read: (elements: { value: string; label: string }[]) => R) => {
          this.calls.push(`read ${testid} ${selector}`);
          const reads = this.optionReads[testid] ?? [[]];
          return Promise.resolve(read((reads.length > 1 ? reads.shift() : reads[0]) ?? []));
        },
      }),
      selectOption: (option: unknown) => {
        this.calls.push(`select ${testid} ${JSON.stringify(option)}`);
        return Promise.resolve([]);
      },
    };
  }

  asPage(): Page {
    return this as unknown as Page;
  }
}

describe("openCanvas", () => {
  const clicks = (page: FakeDrivePage) => page.calls.filter((call) => call.startsWith("click "));

  it("opens the seeded blueprint by its id, then waits for the canvas", async () => {
    const page = new FakeDrivePage();

    await openCanvas(page, { flowId: "f-seeded" });

    expect(clicks(page)).toEqual(["click blueprint-open-f-seeded"]);
    expect(page.calls.indexOf("click blueprint-open-f-seeded")).toBeLessThan(page.calls.length - 1);
  });

  it("makes a new blueprint when no flow id is given, then waits for the canvas", async () => {
    const page = new FakeDrivePage();

    await openCanvas(page, {});

    expect(clicks(page)).toEqual(["click blueprint-new"]);
    expect(page.calls.indexOf("click blueprint-new")).toBeLessThan(page.calls.length - 1);
  });
});

describe("playwrightPage", () => {
  const layout = () => ({
    "palette-agent": { x: 0, y: 700, width: 80, height: 40 },
    canvas: { x: 120.25, y: 600.625, width: 800, height: 600 },
  });

  it("scrolls both ends into view before measuring, then drops on the whole pixel at the offset", async () => {
    const page = new FakePlaywrightPage(layout(), 900);

    await playwrightPage(page.asPage()).drag("palette-agent", "canvas", { x: 40, y: 30 });

    expect(page.scrollY).toBe(600);
    expect(page.calls).toEqual(["move 40,120", "down", "move 160,31 steps 10", "up"]);
  });

  it("drops on the centre of the target when no offset is given", async () => {
    const page = new FakePlaywrightPage(layout(), 2000);

    await playwrightPage(page.asPage()).drag("palette-agent", "canvas");

    expect(page.calls).toEqual(["move 40,720", "down", "move 520.25,900.625 steps 10", "up"]);
  });

  it("names an element that has no box and presses nothing", async () => {
    const page = new FakePlaywrightPage({ ...layout(), canvas: null }, 2000);

    await expect(playwrightPage(page.asPage()).drag("palette-agent", "canvas")).rejects.toThrow(
      "canvas is not visible",
    );
    expect(page.calls).toEqual([]);
  });

  it("clicks the given point of the element, in px from its top-left", async () => {
    const page = new FakePlaywrightPage(layout(), 2000);

    await playwrightPage(page.asPage()).clickAt("container-frame-session-1", { x: 6, y: 6 });

    expect(page.calls).toEqual(['click container-frame-session-1 {"position":{"x":6,"y":6}}']);
  });

  describe("select", () => {
    const testid = "container-session-1-model";
    const models = () =>
      new FakePlaywrightPage(layout(), 2000, {
        [testid]: [
          [
            { value: "opus", label: "Opus (latest)" },
            { value: "haiku", label: "Haiku (latest)" },
          ],
        ],
      });
    const selections = (page: FakePlaywrightPage) =>
      page.calls.filter((call) => call.startsWith("select "));

    it.each([
      [{ value: "haiku" }, `select ${testid} {"value":"haiku"}`],
      [{ label: "Haiku (latest)" }, `select ${testid} {"label":"Haiku (latest)"}`],
    ])("picks the option by %o", async (option, call) => {
      const page = models();

      await playwrightPage(page.asPage()).select(testid, option);

      expect(selections(page)).toEqual([call]);
    });

    it.each([
      [{ value: "nope" }, 'value "nope"'],
      [{ label: "Nope" }, 'label "Nope"'],
    ])(
      "fails on a missing option by %o, listing the options and selecting nothing",
      async (option, wanted) => {
        const page = models();

        await expect(
          playwrightPage(page.asPage(), { optionWaitMs: 50 }).select(testid, option),
        ).rejects.toThrow(
          `${testid} has no option with ${wanted} (options: opus "Opus (latest)", haiku "Haiku (latest)")`,
        );
        expect(selections(page)).toEqual([]);
      },
    );

    it("waits for an option that the dropdown fills in later", async () => {
      const page = new FakePlaywrightPage(layout(), 2000, {
        "branch-field": [
          [],
          [{ value: "main", label: "main" }],
          [{ value: "main", label: "main" }],
        ],
      });

      await playwrightPage(page.asPage()).select("branch-field", { value: "main" });

      expect(selections(page)).toEqual(['select branch-field {"value":"main"}']);
    });

    it("fails on an element with no options, asking whether it is a <select>", async () => {
      const page = new FakePlaywrightPage(layout(), 2000);

      await expect(
        playwrightPage(page.asPage(), { optionWaitMs: 50 }).select("canvas", { value: "main" }),
      ).rejects.toThrow("canvas has no options; is it a <select>?");
      expect(selections(page)).toEqual([]);
    });
  });

  it("sends a press step to the keyboard unchanged", async () => {
    const page = new FakePlaywrightPage(layout(), 2000);

    await playwrightPage(page.asPage()).press("Meta+Shift+z");

    expect(page.calls).toEqual(["press Meta+Shift+z"]);
  });
});

describe("forceExit", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("flushes through evaluate, kills the app's process group, never close(), and waits for the exit event", async () => {
    const app = new FakeApp();
    const kill = vi.spyOn(process, "kill");

    await forceExit(app);

    expect(kill).toHaveBeenCalledWith(-(app.proc.pid ?? 0), "SIGKILL");
    expect(app.evaluateCalls).toBe(2);
    expect(app.closeCalls).toBe(0);
    expect(app.proc.exitCode).toBe(0);
  });

  it.each([
    ["an exit code", { exitCode: 0, signalCode: null }],
    ["a signal", { exitCode: null, signalCode: "SIGTERM" as const }],
  ])("returns at once when the app has already exited with %s", async (_, exited) => {
    const app = new FakeApp();
    Object.assign(app.proc, exited);

    await forceExit(app);

    expect(app.evaluateCalls).toBe(0);
    expect(app.closeCalls).toBe(0);
  });

  it("passes when every engine pid it was given has exited", async () => {
    const child = spawn(process.execPath, ["-e", ""]);
    await once(child, "exit");
    const app = new FakeApp();
    app.enginePids = [child.pid ?? -1];

    await expect(forceExit(app, { timeoutMs: 200 })).resolves.toBeUndefined();
  });

  it("throws when an engine process outlives the app", async () => {
    const app = new FakeApp();
    app.enginePids = [process.pid];

    await expect(forceExit(app, { timeoutMs: 50 })).rejects.toThrow(
      `engine process ${process.pid} outlived the app`,
    );
  });

  it("throws when the app does not exit within the timeout", async () => {
    class StuckApp extends FakeApp {
      override evaluate<R>(): Promise<R> {
        this.evaluateCalls += 1;
        return Promise.resolve([] as R);
      }
    }

    await expect(forceExit(new StuckApp(), { timeoutMs: 50 })).rejects.toThrow(
      "the app did not exit within 50 ms",
    );
  });

  it("throws before flushing when the app has no pid", async () => {
    const app = new FakeApp();
    Object.defineProperty(app.proc, "pid", { value: undefined });

    await expect(forceExit(app)).rejects.toThrow("the app has no pid");
    expect(app.evaluateCalls).toBe(1);
  });

  it("resolves when the app's process group is already gone by the time it is killed", async () => {
    class ExitsDuringFlushApp extends FakeApp {
      override async evaluate<R>(): Promise<R> {
        if (this.evaluateCalls === 1) {
          const child = this.proc.standIn();
          const exited = once(child, "exit");
          child.kill("SIGKILL");
          await exited;
        }
        return super.evaluate<R>();
      }
    }
    const app = new ExitsDuringFlushApp();
    const pid = app.proc.pid ?? -1;
    const kill = vi.spyOn(process, "kill");

    await expect(forceExit(app)).resolves.toBeUndefined();

    expect(kill).toHaveBeenCalledWith(-pid, "SIGKILL");
  });

  it("returns quietly when evaluate fails because the app exited meanwhile", async () => {
    const app = new FakeApp();
    app.evaluateError = new Error("target closed");
    setTimeout(() => {
      app.proc.exitCode = 0;
      app.proc.emit("exit", 0, null);
    }, 0);

    await expect(forceExit(app)).resolves.toBeUndefined();
  });

  describe("the snippet evaluated in main", () => {
    class ElectronFakeApp extends FakeApp {
      exitedAt: number | undefined;
      readonly calls: string[] = [];
      private readonly electronProcess: ChildProcess;

      constructor(
        private readonly shutdownMs = 0,
        script = "process.on('SIGTERM', () => {}); setTimeout(() => {}, 60_000);",
      ) {
        super();
        this.electronProcess = this.proc.standIn(script);
        this.electronProcess.once("exit", (code, signal) => {
          this.exitedAt = Date.now();
          this.proc.exitCode = code;
          this.proc.signalCode = signal;
          this.proc.emit("exit", code, signal);
        });
      }

      override evaluate<R, Arg>(
        fn?: (electron: typeof Electron, arg: Arg) => R | Promise<R>,
        arg?: Arg,
      ): Promise<R> {
        this.evaluateCalls += 1;
        const electron = {
          app: {
            getAppMetrics: () =>
              this.enginePids.map((pid) => ({
                type: "Utility",
                serviceName: "node.mojom.NodeService",
                pid,
              })),
            exit: () => {
              setTimeout(() => this.electronProcess.kill("SIGINT"), this.shutdownMs).unref();
            },
          },
          session: {
            defaultSession: {
              flushStorageData: () => {
                this.calls.push("flushStorageData");
              },
            },
          },
        } as unknown as typeof Electron;
        return Promise.resolve(fn?.(electron, arg as Arg) as R);
      }
    }

    const uncaught: unknown[] = [];
    const onUncaught = (error: unknown) => uncaught.push(error);

    beforeEach(() => {
      uncaught.length = 0;
      process.prependListener("uncaughtException", onUncaught);
    });

    afterEach(() => {
      process.removeListener("uncaughtException", onUncaught);
      vi.restoreAllMocks();
    });

    it("ends an app whose shutdown is slow by flushing storage, then killing its process group", async () => {
      const app = new ElectronFakeApp(30_000);
      const pid = app.proc.pid ?? -1;
      const kill = process.kill.bind(process);
      vi.spyOn(process, "kill").mockImplementation((target, signal) => {
        if (signal === "SIGKILL") app.calls.push(`kill ${target} ${signal}`);
        return kill(target, signal);
      });

      await expect(forceExit(app, { timeoutMs: 1000 })).resolves.toBeUndefined();

      expect(app.calls).toEqual(["flushStorageData", `kill ${-pid} SIGKILL`]);
      let probe: unknown;
      try {
        process.kill(pid, 0);
      } catch (error) {
        probe = error;
      }
      expect(probe).toMatchObject({ code: "ESRCH" });
    });

    it("still exits the app when an engine pid is already gone", async () => {
      const child = spawn(process.execPath, ["-e", ""]);
      await once(child, "exit");
      const app = new ElectronFakeApp();
      app.enginePids = [child.pid ?? -1];

      await expect(forceExit(app, { timeoutMs: 200 })).resolves.toBeUndefined();
      expect(app.calls).toEqual(["flushStorageData"]);
      expect(app.proc.signalCode).toBe("SIGKILL");
      expect(uncaught).toEqual([]);
    });

    const children: ReturnType<typeof spawn>[] = [];

    const engineChild = async (onTerm: "exit-after-300ms" | "ignore") => {
      const script =
        onTerm === "ignore"
          ? "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); console.log('ready');"
          : "process.on('SIGTERM', () => setTimeout(() => process.exit(0), 300)); setInterval(() => {}, 1000); console.log('ready');";
      const child = spawn(process.execPath, ["-e", script], {
        stdio: ["ignore", "pipe", "ignore"],
      });
      children.push(child);
      await once(child.stdout, "data");
      let exitedAt: number | undefined;
      child.once("exit", () => {
        exitedAt = Date.now();
      });
      return { pid: child.pid ?? -1, exitedAt: () => exitedAt };
    };

    afterEach(() => {
      for (const child of children.splice(0)) child.kill("SIGKILL");
    });

    it("exits the app only after an engine that stops on SIGTERM has exited", async () => {
      const engine = await engineChild("exit-after-300ms");
      const app = new ElectronFakeApp();
      app.enginePids = [engine.pid];

      await expect(forceExit(app, { timeoutMs: 5000 })).resolves.toBeUndefined();

      expect(app.calls).toEqual(["flushStorageData"]);
      expect(app.proc.signalCode).toBe("SIGKILL");
      expect(engine.exitedAt()).toBeDefined();
      expect(app.exitedAt).toBeGreaterThanOrEqual(engine.exitedAt() ?? Infinity);
    });

    it("exits the app after timeoutMs and reports an engine that ignores SIGTERM", async () => {
      const engine = await engineChild("ignore");
      const app = new ElectronFakeApp();
      app.enginePids = [engine.pid];
      const started = Date.now();

      await expect(forceExit(app, { timeoutMs: 300 })).rejects.toThrow(
        `engine process ${engine.pid} outlived the app`,
      );

      expect(app.calls).toEqual(["flushStorageData"]);
      expect(app.proc.signalCode).toBe("SIGKILL");
      expect((app.exitedAt ?? 0) - started).toBeGreaterThanOrEqual(300);
    });

    it("reports an engine that ignores SIGTERM even when it shares the app's process group", async () => {
      const engineScript =
        "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); console.log('ready');";
      const app = new ElectronFakeApp(
        0,
        `const engine = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(engineScript)}], { stdio: ['ignore', 'pipe', 'ignore'] });
        engine.stdout.once('data', () => console.log(engine.pid));
        setInterval(() => {}, 1000);`,
      );
      const appPid = app.proc.pid ?? -1;
      const stdout = app.proc.standIn().stdout;
      if (!stdout) throw new Error("the stand-in app has no stdout");
      const [line] = (await once(stdout, "data")) as [Buffer];
      const enginePid = Number(line.toString().trim());
      expect(Number.isInteger(enginePid) && enginePid > 0).toBe(true);
      app.enginePids = [enginePid];

      await expect(forceExit(app, { timeoutMs: 300 })).rejects.toThrow(
        `engine process ${enginePid} outlived the app`,
      );

      await vi.waitFor(() => {
        expect(isAlive(appPid)).toBe(false);
        expect(isAlive(enginePid)).toBe(false);
      });
    });

    it("lets no kill error escape and still exits, leaving the engine to the survivor check", async () => {
      const enginePid = 999_999;
      const kill = process.kill.bind(process);
      vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
        if (pid !== enginePid) return kill(pid, signal);
        if (signal === 0) return true;
        throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
      });
      const app = new ElectronFakeApp();
      app.enginePids = [enginePid];

      await expect(forceExit(app, { timeoutMs: 50 })).rejects.toThrow(
        `engine process ${enginePid} outlived the app`,
      );
      expect(app.calls).toEqual(["flushStorageData"]);
      expect(app.proc.signalCode).toBe("SIGKILL");
      expect(uncaught).toEqual([]);
    });
  });

  it("reports an evaluate error instead of swallowing it", async () => {
    const app = new FakeApp();
    app.evaluateError = new Error("target closed");

    await expect(forceExit(app)).rejects.toThrow("target closed");
  });
});

describe("resolveHome", () => {
  const made: string[] = [];

  afterEach(async () => {
    await Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("uses FLOWDECK_HOME from the environment and keeps it", async () => {
    const own = await mkdtemp(join(tmpdir(), "fd-drive-own-"));
    made.push(own);

    expect(await resolveHome({ FLOWDECK_HOME: own })).toEqual({ home: own, keep: true });
  });

  it.each([
    ["unset", {}],
    ["empty", { FLOWDECK_HOME: "" }],
  ])("makes a fresh temporary home it does not keep when FLOWDECK_HOME is %s", async (_, env) => {
    const resolved = await resolveHome(env);
    made.push(resolved.home);

    expect(resolved.keep).toBe(false);
    expect(resolved.home.startsWith(join(tmpdir(), "fd-drive-home-"))).toBe(true);
    expect(existsSync(resolved.home)).toBe(true);
  });
});

describe("drive cleanup", () => {
  let outDir: string;
  let home: string;
  let userHome: string;
  let app: FakeApp;
  const launch = () => Promise.resolve(app);

  beforeEach(async () => {
    outDir = await mkdtemp(join(tmpdir(), "fd-drive-"));
    home = await mkdtemp(join(tmpdir(), "fd-drive-home-"));
    userHome = await mkdtemp(join(tmpdir(), "fd-drive-user-"));
    vi.stubEnv("HOME", userHome);
    app = new FakeApp();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(outDir, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
    await rm(userHome, { recursive: true, force: true });
  });

  it("closes the app and removes its home when the first window never opens", async () => {
    app.windowError = new Error("no window");

    await expect(drive([], { outDir, home, launch })).rejects.toThrow("no window");
    expect(app.evaluateCalls).toBe(2);
    expect(app.closeCalls).toBe(0);
    expect(existsSync(home)).toBe(false);
  });

  it("removes its home and reports the forceExit error when force-exiting the app fails", async () => {
    app.evaluateError = new Error("exit failed");

    await expect(drive([], { outDir, home, launch })).rejects.toThrow("exit failed");
    expect(existsSync(home)).toBe(false);
  });

  it("reports the failing step, not the forceExit error, when both fail", async () => {
    app.evaluateError = new Error("exit failed");

    await expect(
      drive([{ type: "wait-for-text", text: "never", timeoutMs: 1 }], { outDir, home, launch }),
    ).rejects.toThrow("step 1 (wait-for-text): never shown");
    expect(existsSync(home)).toBe(false);
  });

  it("tears down through forceExit, never close()", async () => {
    await drive([], { outDir, home, launch });

    expect(app.evaluateCalls).toBe(2);
    expect(app.closeCalls).toBe(0);
    expect(app.proc.exitCode).toBe(0);
  });

  it.each([
    ["the run passes", undefined],
    ["the first window never opens", new Error("no window")],
  ])("keeps its home when keepHome is set and %s", async (_, windowError) => {
    app.windowError = windowError;

    const run = drive([], { outDir, home, launch, keepHome: true });

    if (windowError) await expect(run).rejects.toThrow("no window");
    else await run;
    expect(app.proc.exitCode).toBe(0);
    expect(existsSync(home)).toBe(true);
  });

  it("relaunches on the same home after close-window and force-exits the new app at the end", async () => {
    const apps: FakeApp[] = [];
    const homes: string[] = [];
    const launchEach = (at: string) => {
      homes.push(at);
      const next = new FakeApp();
      apps.push(next);
      return Promise.resolve(next);
    };

    await drive([{ type: "close-window" }, { type: "relaunch" }], {
      outDir,
      home,
      launch: launchEach,
    });

    expect(homes).toEqual([home, home]);
    expect(apps.map((each) => each.proc.exitCode)).toEqual([0, 0]);
    expect(apps.map((each) => each.closeCalls)).toEqual([0, 0]);
    expect(apps[1]?.evaluateCalls).toBe(2);
    expect(existsSync(home)).toBe(false);
  });

  describe("after close-window", () => {
    class ClosingApp extends FakeApp {
      constructor(private readonly exitsAfterMs: number | undefined) {
        super();
      }

      override evaluate<R>(): Promise<R> {
        if (this.evaluateCalls > 0) return super.evaluate<R>();
        this.evaluateCalls += 1;
        if (this.exitsAfterMs !== undefined) {
          setTimeout(() => {
            this.proc.exitCode = 0;
            this.proc.emit("exit", 0, null);
          }, this.exitsAfterMs);
        }
        return Promise.resolve(false as R);
      }
    }

    it("lets an app that exits by itself finish, without force-exiting it, then relaunches", async () => {
      const first = new ClosingApp(100);
      const second = new FakeApp();
      const queue: FakeApp[] = [first, second];
      const launchEach = () => Promise.resolve(queue.shift() as FakeApp);

      await drive([{ type: "close-window" }, { type: "relaunch" }], {
        outDir,
        home,
        launch: launchEach,
        exitGraceMs: 2000,
      });

      expect(first.evaluateCalls).toBe(1);
      expect(first.proc.exitCode).toBe(0);
      expect(queue).toEqual([]);
      expect(second.evaluateCalls).toBe(2);
    });

    it("fails a page step after a close that ends the app, even though the first close event was held", async () => {
      const closing = new ClosingApp(100);

      await expect(
        drive([{ type: "close-window" }, { type: "click", testid: "x" }], {
          outDir,
          home,
          launch: () => Promise.resolve(closing),
          exitGraceMs: 2000,
        }),
      ).rejects.toThrow(
        "step 2 (click): the window was closed; add a relaunch step before this one",
      );
      expect(closing.clicks).toEqual([]);
    });

    it("keeps driving the same window when the close shows a prompt", async () => {
      const held = new ClosingApp(undefined);
      held.closePrompts = true;

      await drive([{ type: "close-window" }, { type: "click", testid: "close-cancel" }], {
        outDir,
        home,
        launch: () => Promise.resolve(held),
        exitGraceMs: 50,
      });

      expect(held.clicks).toEqual(["close-cancel"]);
    });

    it("force-exits an app that is still alive once the grace period ends", async () => {
      const held = new ClosingApp(undefined);
      held.closePrompts = true;
      const started = Date.now();

      await drive([{ type: "close-window" }], {
        outDir,
        home,
        launch: () => Promise.resolve(held),
        exitGraceMs: 200,
      });

      expect(Date.now() - started).toBeGreaterThanOrEqual(200);
      expect(held.evaluateCalls).toBe(3);
      expect(held.proc.exitCode).toBe(0);
      expect(existsSync(home)).toBe(false);
    });

    it("force-exits at once when no close-window came before the relaunch", async () => {
      const first = new FakeApp();
      const queue: FakeApp[] = [first, new FakeApp()];
      const started = Date.now();

      await drive([{ type: "relaunch" }], {
        outDir,
        home,
        launch: () => Promise.resolve(queue.shift() as FakeApp),
        exitGraceMs: 5000,
      });

      expect(Date.now() - started).toBeLessThan(1000);
      expect(first.proc.exitCode).toBe(0);
    });
  });
});

describe("drive on a temp Claude config", () => {
  let outDir: string;
  let home: string;
  let userHome: string;

  beforeEach(async () => {
    outDir = await mkdtemp(join(tmpdir(), "fd-drive-"));
    home = await mkdtemp(join(tmpdir(), "fd-drive-home-"));
    userHome = await mkdtemp(join(tmpdir(), "fd-drive-user-"));
    await mkdir(join(userHome, ".claude"), { recursive: true });
    await writeFile(join(userHome, ".claude", "settings.json"), '{"model":"haiku"}');
    vi.stubEnv("HOME", userHome);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(outDir, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
    await rm(userHome, { recursive: true, force: true });
  });

  it("launches with CLAUDE_CONFIG_DIR on a .claude folder under its home that holds the copied settings", async () => {
    const launches: { env: Readonly<Record<string, string>> | undefined; settings: string }[] = [];
    const launch = async (_: string, __?: unknown, env?: Readonly<Record<string, string>>) => {
      const configDir = env?.["CLAUDE_CONFIG_DIR"];
      launches.push({
        env,
        settings:
          configDir === undefined
            ? ""
            : await readFile(join(configDir, "settings.json"), "utf8").catch(() => ""),
      });
      return new FakeApp();
    };

    await drive([], { outDir, home, launch });

    expect(launches).toHaveLength(1);
    expect(launches[0]?.env).toMatchObject({
      CLAUDE_CONFIG_DIR: join(home, ".claude"),
      CLAUDE_SECURESTORAGE_CONFIG_DIR: "",
    });
    expect(JSON.parse(launches[0]?.settings || "null")).toEqual({ model: "haiku" });
  });

  it("leaves the Claude config out of a launchApp on its own, the e2e path", async () => {
    vi.stubEnv("CLAUDE_CONFIG_DIR", undefined);
    vi.stubEnv("CLAUDE_SECURESTORAGE_CONFIG_DIR", undefined);
    const electronLaunch = vi
      .spyOn(_electron, "launch")
      .mockImplementation(() => Promise.resolve(new FakeApp() as never));
    try {
      const launched = await launchApp({ home, logPath: join(outDir, "app.log") });
      await launched.close();

      const env = electronLaunch.mock.calls[0]?.[0]?.env;
      expect(env).toBeDefined();
      expect(env).not.toHaveProperty("CLAUDE_CONFIG_DIR");
      expect(env).not.toHaveProperty("CLAUDE_SECURESTORAGE_CONFIG_DIR");
    } finally {
      electronLaunch.mockRestore();
    }
  });
});

describe("reportFailure", () => {
  it("writes the error and ends the process with exit code 1, so open app handles cannot keep it alive", () => {
    const written: string[] = [];
    const exits: number[] = [];

    reportFailure(new Error("the app did not exit within 5000 ms"), {
      write: (text) => written.push(text),
      exit: (code) => exits.push(code),
    });

    expect(written).toEqual(["drive failed: the app did not exit within 5000 ms\n"]);
    expect(exits).toEqual([1]);
  });
});

describe("launchApp log", () => {
  let outDir: string;

  beforeEach(async () => {
    outDir = await mkdtemp(join(tmpdir(), "fd-drive-"));
  });

  afterEach(async () => {
    await rm(outDir, { recursive: true, force: true });
  });

  it("keeps stderr in the log after stdout has ended", async () => {
    const app = new FakeApp();
    const logPath = join(outDir, "app.log");
    const launched = await launchApp({ home: outDir, logPath, launch: () => Promise.resolve(app) });

    app.stdout.end("main: engine started\n");
    await setImmediate();
    app.stderr.end("engine: store ready\n");
    await launched.close();

    const log = await readFile(logPath, "utf8");
    expect(log).toContain("main: engine started");
    expect(log).toContain("engine: store ready");
  });

  it("forwards the evaluate argument to the launched app", async () => {
    const received: unknown[] = [];
    const app = new (class extends FakeApp {
      override evaluate<R>(_fn?: unknown, arg?: unknown): Promise<R> {
        received.push(arg);
        return super.evaluate<R>();
      }
    })();
    const launched = await launchApp({
      home: outDir,
      logPath: join(outDir, "app.log"),
      launch: () => Promise.resolve(app),
    });

    await launched.app.evaluate((_electron, testId: string) => testId, "canvas-save");
    await launched.close();

    expect(received[0]).toBe("canvas-save");
  });
});

describe("launchApp colour scheme", () => {
  let outDir: string;
  let electronLaunch: MockInstance<typeof _electron.launch>;

  beforeEach(async () => {
    outDir = await mkdtemp(join(tmpdir(), "fd-drive-"));
    electronLaunch = vi
      .spyOn(_electron, "launch")
      .mockImplementation(() => Promise.resolve(new FakeApp() as never));
  });

  afterEach(async () => {
    electronLaunch.mockRestore();
    await rm(outDir, { recursive: true, force: true });
  });

  it.each(["dark", "light"] as const)(
    "passes colorScheme %s to the Electron launch options",
    async (colorScheme) => {
      const launched = await launchApp({
        home: outDir,
        logPath: join(outDir, "app.log"),
        colorScheme,
      });
      await launched.close();

      expect(electronLaunch).toHaveBeenCalledTimes(1);
      expect(electronLaunch.mock.calls[0]?.[0]).toMatchObject({
        colorScheme,
        env: expect.objectContaining({ FLOWDECK_HOME: outDir }),
      });
    },
  );

  it("adds the extra env it is given, and never lets it move FLOWDECK_HOME", async () => {
    const launched = await launchApp({
      home: outDir,
      logPath: join(outDir, "app.log"),
      env: { FLOWDECK_CLAUDE_CONFIG: "/tmp/x/.claude.json", FLOWDECK_HOME: "/elsewhere" },
    });
    await launched.close();

    expect(electronLaunch.mock.calls[0]?.[0]).toMatchObject({
      env: expect.objectContaining({
        FLOWDECK_CLAUDE_CONFIG: "/tmp/x/.claude.json",
        FLOWDECK_HOME: outDir,
      }),
    });
  });

  it("passes no colorScheme when none is given", async () => {
    const launched = await launchApp({ home: outDir, logPath: join(outDir, "app.log") });
    await launched.close();

    expect(electronLaunch).toHaveBeenCalledTimes(1);
    expect(electronLaunch.mock.calls[0]?.[0]).not.toHaveProperty("colorScheme");
  });
});
