import { mkdir, mkdtemp, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { kitVersion } from "../../core/compiler/kit-version.js";

export type PreparedKit = { dir: string; version: string };

const readKitFiles = async (sourceDir: string) => {
  const entries = await readdir(sourceDir, { recursive: true, withFileTypes: true });
  return Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map(async (entry) => {
        const path = join(entry.parentPath, entry.name);
        return { path: relative(sourceDir, path), content: await readFile(path, "utf8") };
      }),
  );
};

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

export async function prepareKit(options: {
  sourceDir: string;
  home: string;
}): Promise<PreparedKit> {
  const files = await readKitFiles(options.sourceDir);
  const version = kitVersion(files);
  const kitRoot = join(options.home, "kit");
  const dir = join(kitRoot, version);
  if (await exists(dir)) return { dir, version };
  await mkdir(kitRoot, { recursive: true });
  const staging = await mkdtemp(join(kitRoot, `.${version}-`));
  // fs.cp cannot read from inside app.asar; readFile can.
  for (const file of files) {
    await mkdir(dirname(join(staging, file.path)), { recursive: true });
    await writeFile(join(staging, file.path), file.content, "utf8");
  }
  await rename(staging, dir);
  return { dir, version };
}
