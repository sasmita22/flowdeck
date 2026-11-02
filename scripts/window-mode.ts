type Env = Readonly<Record<string, string | undefined>>;

const hideFlag = "FLOWDECK_HIDE_WINDOW";

export const testDisplayFlags = ["--force-device-scale-factor=1", "--force-color-profile=srgb"];

export const hideWindow = (env: Env): boolean =>
  env[hideFlag] === "1" || (env["CLAUDECODE"] === "1" && env["FLOWDECK_SHOW_WINDOW"] !== "1");

export function withWindowMode(env: Env): Record<string, string> {
  const kept = Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] => entry[0] !== hideFlag && entry[1] !== undefined,
    ),
  );
  return hideWindow(env) ? { ...kept, [hideFlag]: "1" } : kept;
}
