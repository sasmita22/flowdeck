export const EMPTY_ENV_CARRIER = "FLOWDECK_EMPTY_ENV";

type Env = Record<string, string | undefined>;

export function carryEmptyEnv<E extends Env>(env: E): E {
  const empty = Object.keys(env).filter((name) => env[name] === "");
  return empty.length === 0 ? env : { ...env, [EMPTY_ENV_CARRIER]: JSON.stringify(empty) };
}

export function emptyEnvOf(env: Env): Record<string, string> {
  const names = parseNames(env[EMPTY_ENV_CARRIER]);
  return Object.fromEntries(names.map((name) => [name, ""]));
}

function parseNames(carrier: string | undefined): string[] {
  if (carrier === undefined) return [];
  try {
    const parsed: unknown = JSON.parse(carrier);
    return Array.isArray(parsed)
      ? parsed.filter((name): name is string => typeof name === "string")
      : [];
  } catch {
    return [];
  }
}
