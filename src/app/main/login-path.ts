export const pathStartMarker = "__FLOWDECK_PATH_START__";
export const pathEndMarker = "__FLOWDECK_PATH_END__";

type ShellResult = { code: number | null; stdout: string };

const markedPath = (stdout: string): string | undefined => {
  const start = stdout.indexOf(pathStartMarker);
  if (start === -1) return undefined;
  const from = start + pathStartMarker.length;
  const end = stdout.indexOf(pathEndMarker, from);
  return end === -1 ? undefined : stdout.slice(from, end);
};

export async function loginPath(options: {
  shell: string | undefined;
  run: (command: string, args: readonly string[]) => Promise<ShellResult>;
  timeoutMs: number;
}): Promise<string | undefined> {
  const script = `printf '%s' "${pathStartMarker}\${PATH}${pathEndMarker}"`;
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), options.timeoutMs);
  });
  const read = options
    .run(options.shell ?? "/bin/zsh", ["-ilc", script])
    .then((result) => (result.code === 0 ? markedPath(result.stdout) : undefined))
    .catch(() => undefined);
  try {
    return await Promise.race([read, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}
