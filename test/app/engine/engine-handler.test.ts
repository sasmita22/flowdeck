import { describe, expect, it } from "vitest";
import { createEngineHandler } from "../../../src/app/engine/engine-handler.js";

describe("createEngineHandler", () => {
  it("answers a version request with the injected version under the request's id", () => {
    const handler = createEngineHandler({ version: "1.2.3", openStore: () => undefined });

    expect(handler.handle({ id: 1, type: "version" })).toEqual({ id: 1, ok: true, value: "1.2.3" });
  });

  it("reports the store as ready when it opens", () => {
    const handler = createEngineHandler({ version: "1.2.3", openStore: () => undefined });

    expect(handler.handle({ id: 7, type: "store-status" })).toEqual({
      id: 7,
      ok: true,
      value: { kind: "ready" },
    });
  });

  it("reports the open error as the store status instead of throwing", () => {
    const handler = createEngineHandler({
      version: "1.2.3",
      openStore: () => {
        throw new Error("boom");
      },
    });

    expect(handler.handle({ id: 2, type: "store-status" })).toEqual({
      id: 2,
      ok: true,
      value: { kind: "error", message: "boom" },
    });
  });

  it("opens the store once however many status requests arrive", () => {
    let opens = 0;
    const handler = createEngineHandler({ version: "1.2.3", openStore: () => void opens++ });

    handler.handle({ id: 1, type: "store-status" });
    handler.handle({ id: 2, type: "store-status" });
    handler.handle({ id: 3, type: "store-status" });

    expect(opens).toBe(1);
  });
});
