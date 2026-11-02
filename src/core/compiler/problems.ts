import { NodeType } from "../flow/schema.js";
import type { ValidationError } from "./validate.js";

export type Problem = { node?: string | undefined; field?: string | undefined; text: string };

const typeTags = new RegExp(` \\((?:${NodeType.options.join("|")})\\)`, "g");

const capitalised = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

export const plainReason = (nodeId: string | undefined, message: string): string => {
  const untagged = message.replace(typeTags, "");
  if (nodeId === undefined || !untagged.startsWith(`${nodeId} `)) return untagged;
  return capitalised(untagged.slice(nodeId.length + 1));
};

export const reasonNaming = (
  nodeId: string | undefined,
  message: string,
  label: string,
): string => {
  const untagged = message.replace(typeTags, "");
  if (nodeId === undefined || !untagged.startsWith(`${nodeId} `)) return untagged;
  return `${label}${untagged.slice(nodeId.length)}`;
};

export const plainProblems = (errors: readonly ValidationError[]): Problem[] =>
  errors.map(({ node, field, message }) => ({
    ...(node === undefined ? {} : { node }),
    ...(field === undefined ? {} : { field }),
    text: plainReason(node, message),
  }));
