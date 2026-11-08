import type {
  ToolSocket,
  ToolSocketHandler,
  ToolSocketMessage,
} from "../../src/ports/tool-socket.js";

export class FakeToolSocket implements ToolSocket {
  listening: string | undefined;
  private handler: ToolSocketHandler | undefined;

  async listen(path: string, handler: ToolSocketHandler): Promise<void> {
    this.listening = path;
    this.handler = handler;
  }

  async close(): Promise<void> {
    this.listening = undefined;
    this.handler = undefined;
  }

  async deliver(message: ToolSocketMessage): Promise<unknown> {
    if (this.handler === undefined) throw new Error("FakeToolSocket is not listening");
    return this.handler(message);
  }
}
