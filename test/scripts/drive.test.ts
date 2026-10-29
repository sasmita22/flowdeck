import type { Page } from "@playwright/test";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  drive,
  launchApp,
  parseSteps,
  playwrightPage,
  runSteps,
  type DriveApp,
  type DrivePage,
} from "../../scripts/drive.js";

class FakeDrivePage implements DrivePage {
  readonly calls: string[] = [];
  failOn: string | undefined;

  private act(call: string): Promise<void> {
    this.calls.push(call);
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

  async screenshot(path: string): Promise<void> {
    await this.act(`screenshot`);
    await writeFile(path, "png");
  }

  ariaSnapshot(): Promise<string> {
    return Promise.resolve('- heading "Flowdeck" [level=1]\n');
  }
}

const windowThatNeverShowsText = {
  getByText: () => ({ first: () => ({ waitFor: () => Promise.reject(new Error("never shown")) }) }),
} as unknown as Page;

class FakeApp implements DriveApp {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  closeCalls = 0;
  windowError: Error | undefined;
  closeError: Error | undefined;

  process() {
    return { pid: 4242, stdout: this.stdout, stderr: this.stderr };
  }

  firstWindow(): Promise<Page> {
    if (this.windowError) return Promise.reject(this.windowError);
    return Promise.resolve(windowThatNeverShowsText);
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
      { type: "drag", from: "palette-prompt", to: "canvas", toPosition: { x: 200, y: 150 } },
      { type: "drag", from: "prompt-1-out", to: "script-1-in" },
      { type: "press", key: "Meta+z" },
    ];

    expect(parseSteps(JSON.stringify(steps))).toEqual(steps);
  });

  it.each([
    ["a drag without to", { type: "drag", from: "palette-prompt" }, "drag", "→ at to"],
    [
      "a drag with a non-numeric toPosition",
      { type: "drag", from: "palette-prompt", to: "canvas", toPosition: { x: "200", y: 150 } },
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

  it("dispatches drag and press to the page in step order", async () => {
    await runSteps(
      [
        { type: "drag", from: "palette-prompt", to: "canvas", toPosition: { x: 200, y: 150 } },
        { type: "click", testid: "canvas-undo" },
        { type: "drag", from: "prompt-1-out", to: "script-1-in" },
        { type: "press", key: "Meta+z" },
        { type: "press", key: "Shift+Meta+z" },
      ],
      page,
      { outDir },
    );

    expect(page.calls).toEqual([
      "drag palette-prompt canvas 200,150",
      "click canvas-undo",
      "drag prompt-1-out script-1-in centre",
      "press Meta+z",
      "press Shift+Meta+z",
    ]);
  });

  it("saves evidence only for screenshot steps when drag and press steps run", async () => {
    await runSteps(
      [
        { type: "drag", from: "palette-script", to: "canvas", toPosition: { x: 10, y: 20 } },
        { type: "press", key: "Delete" },
        { type: "screenshot" },
      ],
      page,
      { outDir },
    );

    expect(page.calls).toEqual(["drag palette-script canvas 10,20", "press Delete", "screenshot"]);
    expect((await readdir(outDir)).sort()).toEqual(["step-3.aria.yml", "step-3.png"]);
  });

  it("stops at a failing drag and names it by index and type", async () => {
    page.failOn = "drag palette-prompt nowhere centre";

    await expect(
      runSteps(
        [
          { type: "drag", from: "palette-prompt", to: "nowhere" },
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
});

type Box = { x: number; y: number; width: number; height: number };

class FakePlaywrightPage {
  readonly calls: string[] = [];
  scrollY = 0;

  constructor(
    private readonly boxes: Record<string, Box | null>,
    private readonly viewportHeight: number,
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
    };
  }

  asPage(): Page {
    return this as unknown as Page;
  }
}

describe("playwrightPage", () => {
  const layout = () => ({
    "palette-prompt": { x: 0, y: 700, width: 80, height: 40 },
    canvas: { x: 120.25, y: 600.625, width: 800, height: 600 },
  });

  it("scrolls both ends into view before measuring, then drops on the whole pixel at the offset", async () => {
    const page = new FakePlaywrightPage(layout(), 900);

    await playwrightPage(page.asPage()).drag("palette-prompt", "canvas", { x: 40, y: 30 });

    expect(page.scrollY).toBe(600);
    expect(page.calls).toEqual(["move 40,120", "down", "move 160,31 steps 10", "up"]);
  });

  it("drops on the centre of the target when no offset is given", async () => {
    const page = new FakePlaywrightPage(layout(), 2000);

    await playwrightPage(page.asPage()).drag("palette-prompt", "canvas");

    expect(page.calls).toEqual(["move 40,720", "down", "move 520.25,900.625 steps 10", "up"]);
  });

  it("names an element that has no box and presses nothing", async () => {
    const page = new FakePlaywrightPage({ ...layout(), canvas: null }, 2000);

    await expect(playwrightPage(page.asPage()).drag("palette-prompt", "canvas")).rejects.toThrow(
      "canvas is not visible",
    );
    expect(page.calls).toEqual([]);
  });

  it("sends a press step to the keyboard unchanged", async () => {
    const page = new FakePlaywrightPage(layout(), 2000);

    await playwrightPage(page.asPage()).press("Meta+Shift+z");

    expect(page.calls).toEqual(["press Meta+Shift+z"]);
  });
});

describe("drive cleanup", () => {
  let outDir: string;
  let home: string;
  let app: FakeApp;
  const launch = () => Promise.resolve(app);

  beforeEach(async () => {
    outDir = await mkdtemp(join(tmpdir(), "fd-drive-"));
    home = await mkdtemp(join(tmpdir(), "fd-drive-home-"));
    app = new FakeApp();
  });

  afterEach(async () => {
    await rm(outDir, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  it("closes the app and removes its home when the first window never opens", async () => {
    app.windowError = new Error("no window");

    await expect(drive([], { outDir, home, launch })).rejects.toThrow("no window");
    expect(app.closeCalls).toBe(1);
    expect(existsSync(home)).toBe(false);
  });

  it("removes its home and reports the close error when closing the app fails", async () => {
    app.closeError = new Error("close failed");

    await expect(drive([], { outDir, home, launch })).rejects.toThrow("close failed");
    expect(existsSync(home)).toBe(false);
  });

  it("reports the failing step, not the close error, when both fail", async () => {
    app.closeError = new Error("close failed");

    await expect(
      drive([{ type: "wait-for-text", text: "never", timeoutMs: 1 }], { outDir, home, launch }),
    ).rejects.toThrow("step 1 (wait-for-text): never shown");
    expect(existsSync(home)).toBe(false);
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
});
