import {
  replyFits,
  type WaitAnswer,
  type WaitReply,
  type WaitRequest,
} from "../../core/run/wait.js";
import type { Waiter } from "../../ports/waiter.js";
import type { EnginePush } from "./protocol.js";

export type AppWaiter = {
  forRun(runId: string): Waiter;
  answer(answer: WaitAnswer): boolean;
  drop(runId: string): void;
};

type Open = { waitId: string; request: WaitRequest; resolve: (reply: WaitReply) => void };

export function createAppWaiter({ push }: { push(message: EnginePush): void }): AppWaiter {
  let count = 0;
  const queues = new Map<string, Open[]>();

  const queueOf = (runId: string): Open[] => {
    const queue = queues.get(runId) ?? [];
    queues.set(runId, queue);
    return queue;
  };

  const pushHead = (runId: string) => {
    const head = queues.get(runId)?.[0];
    push({
      push: "wait",
      runId,
      value: head === undefined ? null : { waitId: head.waitId, request: head.request },
    });
  };

  const take = (waitId: string): { runId: string; open: Open } | undefined => {
    for (const [runId, queue] of queues) {
      const index = queue.findIndex((open) => open.waitId === waitId);
      const open = queue[index];
      if (open === undefined) continue;
      queue.splice(index, 1);
      if (queue.length === 0) queues.delete(runId);
      if (index === 0) pushHead(runId);
      return { runId, open };
    }
    return undefined;
  };

  const findOpen = (waitId: string): Open | undefined => {
    for (const queue of queues.values()) {
      const open = queue.find((candidate) => candidate.waitId === waitId);
      if (open !== undefined) return open;
    }
    return undefined;
  };

  return {
    forRun: (runId) => ({
      wait(request, signal) {
        count += 1;
        const waitId = `w${count}`;
        return new Promise<WaitReply>((resolve) => {
          const queue = queueOf(runId);
          queue.push({ waitId, request, resolve });
          if (queue.length === 1) pushHead(runId);
          signal?.addEventListener(
            "abort",
            () => take(waitId)?.open.resolve({ decision: "closed" }),
            { once: true },
          );
        });
      },
    }),
    answer({ waitId, reply }) {
      const open = findOpen(waitId);
      if (open === undefined || !replyFits(open.request, reply)) return false;
      take(waitId);
      open.resolve(reply);
      return true;
    },
    drop(runId) {
      const dropped = queues.get(runId);
      if (dropped === undefined) return;
      queues.delete(runId);
      pushHead(runId);
      for (const open of dropped) {
        if (open.request.kind === "permission") open.resolve({ decision: "closed" });
      }
    },
  };
}
