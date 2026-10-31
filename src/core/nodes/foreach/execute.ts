import type { Node } from "../../flow/schema.js";

const marker = /^(?:[-*+]|\d+[.)]) (.*)$/;
const blockStart = /^(?:#|>|(?:-{3,}|\*{3,}|_{3,})\s*$)/;
const fence = /^\s*(`{3,}|~{3,})/;

export function listItems(markdown: string): string[] {
  const items: string[] = [];
  let open = false;
  let afterBlank = false;
  let openFence: string | undefined;
  for (const line of markdown.split(/\r?\n/)) {
    const text = line.trim();
    const run = fence.exec(line)?.[1];
    if (openFence !== undefined) {
      if (run !== undefined && run[0] === openFence[0] && run.length >= openFence.length) {
        openFence = undefined;
      }
      continue;
    }
    if (run !== undefined) {
      openFence = run;
      if (!/^\s/.test(line)) open = false;
      continue;
    }
    if (text === "") {
      afterBlank = true;
      continue;
    }
    const item = marker.exec(line);
    if (item !== null) {
      items.push(item[1]?.trim() ?? "");
      open = true;
    } else if (open && (/^\s/.test(line) || (!afterBlank && !blockStart.test(line)))) {
      items[items.length - 1] = `${items.at(-1) ?? ""} ${text}`;
    } else {
      open = false;
    }
    afterBlank = false;
  }
  return items;
}

export function withItem(turn: string, item: string): string {
  return `${turn} This round's item: ${item}`;
}

export function listPath(cwd: string, file: string): string {
  return `${cwd}/${file}`;
}

export function firstTurnId(body: readonly Pick<Node, "id" | "type">[]): string | undefined {
  return body.find((node) => node.type === "prompt" || node.type === "agent")?.id;
}
