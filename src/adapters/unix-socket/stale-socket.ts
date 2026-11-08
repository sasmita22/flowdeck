import { lstat, unlink } from "node:fs/promises";
import { connect } from "node:net";

export function hasCode(error: unknown, ...codes: string[]): boolean {
  return error instanceof Error && "code" in error && codes.includes(error.code as string);
}

function isLive(path: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const probe = connect(path);
    probe.on("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.on("error", (error) => (hasCode(error, "ECONNREFUSED") ? resolve(false) : reject(error)));
  });
}

export async function removeStaleSocket(path: string): Promise<void> {
  try {
    if (!(await lstat(path)).isSocket()) throw new Error(`"${path}" exists and is not a socket`);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return;
    throw error;
  }
  if (await isLive(path)) throw new Error(`Another server is listening on "${path}"`);
  await unlink(path);
}
