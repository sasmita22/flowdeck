type Fields = Record<string, unknown>;

const isFields = (value: unknown): value is Fields =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const inputVariables = (inputs: unknown): Fields[] =>
  Array.isArray(inputs) ? inputs.map((name) => ({ name, kind: "text" })) : [];

const flagVariables = (flags: unknown): Fields[] =>
  isFields(flags)
    ? Object.entries(flags).map(([name, value]) =>
        typeof value === "boolean"
          ? { name, kind: "yesno", default: value }
          : { name, kind: "text", default: String(value) },
      )
    : [];

const folderConfig = (folder: unknown): Fields =>
  isFields(folder) && folder.kind === "worktree"
    ? { ...(typeof folder.repo === "string" ? { repo: folder.repo } : {}), base: folder.branch }
    : {};

const upgradeNode = (node: unknown, variables: Fields[]): unknown => {
  if (!isFields(node) || !isFields(node.settings)) return node;
  if (node.type === "trigger") {
    const { inputs, flags, ...settings } = node.settings;
    variables.push(...inputVariables(inputs), ...flagVariables(flags));
    return { ...node, settings };
  }
  if (node.type === "branch" && "flag" in node.settings) {
    const { flag, ...settings } = node.settings;
    return { ...node, settings: { ...settings, variable: flag } };
  }
  return node;
};

const upgradeSession = (session: Fields, variables: Fields[]): Fields => {
  if (!("workingFolder" in session) && variables.length === 0) return session;
  const { workingFolder, ...rest } = session;
  const current = isFields(rest.buildConfig) ? rest.buildConfig : {};
  const declared = Array.isArray(current.variables) ? (current.variables as unknown[]) : [];
  return {
    ...rest,
    buildConfig: {
      ...current,
      ...folderConfig(workingFolder),
      variables: [...declared, ...variables],
    },
  };
};

export function upgradeFlow(raw: unknown): unknown {
  if (!isFields(raw) || !Array.isArray(raw.nodes) || !isFields(raw.session)) return raw;
  const variables: Fields[] = [];
  const nodes = raw.nodes.map((node) => upgradeNode(node, variables));
  return { ...raw, nodes, session: upgradeSession(raw.session, variables) };
}
