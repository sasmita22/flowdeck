import type { WaitReply, WaitRequest, Waiter } from "../../src/ports/waiter.js";

export class FakeWaiter implements Waiter {
  readonly calls: WaitRequest[] = [];
  private readonly replies: (WaitReply | Promise<WaitReply>)[];

  constructor(replies: (WaitReply | Promise<WaitReply>)[]) {
    this.replies = [...replies];
  }

  async wait(request: WaitRequest): Promise<WaitReply> {
    this.calls.push(request);
    const reply = this.replies[this.calls.length - 1];
    if (reply === undefined) throw new Error(`FakeWaiter: no scripted reply for ${request.nodeId}`);
    return reply;
  }
}
