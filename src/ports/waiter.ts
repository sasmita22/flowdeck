import type { WaitReply, WaitRequest } from "../core/run/wait.js";

export type { WaitReply, WaitRequest };

export interface Waiter {
  wait(request: WaitRequest): Promise<WaitReply>;
}
