import {
  replyFits,
  type WaitAnswer,
  type WaitReply,
  type WaitRequest,
} from "../../core/run/wait.js";
import type { Waiter } from "../../ports/waiter.js";
import type { EnginePush } from "./protocol.js";

export type AppWaiter = Waiter & {
  answer(answer: WaitAnswer): boolean;
  drop(): void;
};

type Open = { waitId: string; request: WaitRequest; resolve: (reply: WaitReply) => void };

export function createAppWaiter({ push }: { push(message: EnginePush): void }): AppWaiter {
  let count = 0;
  let queue: Open[] = [];

  const pushHead = () => {
    const head = queue[0];
    push({
      push: "wait",
      value: head === undefined ? null : { waitId: head.waitId, request: head.request },
    });
  };

  const withdraw = (waitId: string) => {
    const index = queue.findIndex((open) => open.waitId === waitId);
    const open = queue[index];
    if (open === undefined) return;
    queue.splice(index, 1);
    if (index === 0) pushHead();
    open.resolve({ decision: "closed" });
  };

  return {
    wait(request, signal) {
      count += 1;
      const waitId = `w${count}`;
      return new Promise<WaitReply>((resolve) => {
        queue.push({ waitId, request, resolve });
        if (queue.length === 1) pushHead();
        signal?.addEventListener("abort", () => withdraw(waitId), { once: true });
      });
    },
    answer({ waitId, reply }) {
      const index = queue.findIndex((open) => open.waitId === waitId);
      const open = queue[index];
      if (open === undefined || !replyFits(open.request, reply)) return false;
      queue.splice(index, 1);
      if (index === 0) pushHead();
      open.resolve(reply);
      return true;
    },
    drop() {
      if (queue.length === 0) return;
      const dropped = queue;
      queue = [];
      pushHead();
      for (const open of dropped) {
        if (open.request.kind === "permission") open.resolve({ decision: "closed" });
      }
    },
  };
}
