import { sha256Hex } from "./hash.js";
import type { BuildFile } from "./lower.js";

export function kitVersion(files: readonly BuildFile[]): string {
  const lines = files.map((file) => `${sha256Hex(file.path)} ${sha256Hex(file.content)}`).sort();
  return sha256Hex(lines.join("\n")).slice(0, 12);
}
