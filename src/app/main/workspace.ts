import type { EngineClient } from "./engine-client.js";
import type { WindowGuard } from "./window-guard.js";

export const workspaceInfoHandler = (guard: WindowGuard, client: Pick<EngineClient, "request">) =>
  guard.handle((workingFolder: unknown) => client.request("workspace-info", { workingFolder }));
