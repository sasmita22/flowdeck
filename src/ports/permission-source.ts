import type { PermissionAsks, PermissionDecision } from "../core/run/permission.js";

export type { PermissionDecision };

export interface PermissionSource {
  onRequest: PermissionAsks["onRequest"];
}
