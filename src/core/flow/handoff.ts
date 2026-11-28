export const handoffFolderLine = (
  folder: string,
  kind: "workspace" | "session" = "session",
): string =>
  `Hand-off files are read and written by bare name (\`<file>\`, not \`${folder}/<file>\`) in the run's working folder. A run starts there; ${kind === "workspace" ? "for the workspace session" : "in this session's own folder"} that folder is \`${folder}/\`.`;
