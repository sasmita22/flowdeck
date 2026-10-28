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
