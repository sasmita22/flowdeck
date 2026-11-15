import { z } from "zod";

const prefix = "flowdeck/";

export const requestBranchSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("new"), name: z.string(), base: z.string() }),
  z.object({ mode: z.literal("existing"), name: z.string() }),
]);

export type RequestBranch = z.infer<typeof requestBranchSchema>;

export const recommendedBranch = (buildName: string, localBranches: readonly string[]): string => {
  const taken = new Set(localBranches);
  const base = `${prefix}${buildName}`;
  if (!taken.has(base)) return base;
  for (let count = 2; ; count++) {
    const name = `${base}-${count}`;
    if (!taken.has(name)) return name;
  }
};

const forbidden = /[ ~^:?*[\\]|\.\.|\/\/|@\{/;

const isControl = (char: string): boolean => {
  const code = char.charCodeAt(0);
  return code < 0x20 || code === 0x7f;
};

const validComponent = (component: string): boolean =>
  component !== "" && !component.startsWith(".") && !component.endsWith(".lock");

export const isValidBranchName = (name: string): boolean =>
  name !== "" &&
  name !== "@" &&
  name !== "HEAD" &&
  !name.startsWith("-") &&
  !name.endsWith(".") &&
  !forbidden.test(name) &&
  ![...name].some(isControl) &&
  name.split("/").every(validComponent);

export const legacyBranchName = (name: string, buildId: string): string =>
  `${prefix}${name}-${buildId.slice(0, 8)}`;
