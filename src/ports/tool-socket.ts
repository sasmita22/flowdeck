export type ToolSocketMessage =
  | { kind: "tools"; session: string }
  | { kind: "call"; session: string; name: string; input: unknown }
  | { kind: "stop" };

export type ToolSocketHandler = (message: ToolSocketMessage) => Promise<unknown>;

export interface ToolSocket {
  listen(path: string, handler: ToolSocketHandler): Promise<void>;
  close(): Promise<void>;
}
