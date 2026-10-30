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
  let open: Open | undefined;

  const clear = () => {
    open = undefined;
    push({ push: "wait", value: null });
  };

  return {
    wait(request) {
      count += 1;
      const waitId = `w${count}`;
      return new Promise<WaitReply>((resolve) => {
        open = { waitId, request, resolve };
        push({ push: "wait", value: { waitId, request } });
      });
    },
    answer({ waitId, reply }) {
      if (open === undefined || open.waitId !== waitId || !replyFits(open.request, reply)) {
        return false;
      }
      const { resolve } = open;
      clear();
      resolve(reply);
      return true;
    },
    drop() {
      if (open !== undefined) clear();
    },
  };
}
