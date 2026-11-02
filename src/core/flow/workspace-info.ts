import { z } from "zod";
import { Session } from "./schema.js";

export const workingFolderSchema = Session.shape.workingFolder;

export type WorkingFolder = z.infer<typeof workingFolderSchema>;

export const folderStateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("branch"), name: z.string() }),
  z.object({ kind: z.literal("detached"), commit: z.string() }),
  z.object({ kind: z.literal("not-a-repo") }),
  z.object({ kind: z.literal("missing") }),
]);

export type FolderState = z.infer<typeof folderStateSchema>;

export type WorkspaceLabel = { folder: { name: string; title: string }; branch: string };

const folderName = (path: string): string => {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1) || path;
};

const branchText = (state: FolderState | undefined): string => {
  switch (state?.kind) {
    case undefined:
      return "";
    case "branch":
      return state.name;
    case "detached":
      return `detached at ${state.commit}`;
    case "not-a-repo":
      return "not a git repo";
    case "missing":
      return "folder not found";
  }
};

export function workspaceLabel(workingFolder: WorkingFolder, state?: FolderState): WorkspaceLabel {
  if (workingFolder.kind === "worktree") {
    const { repo } = workingFolder;
    return {
      folder: repo
        ? { name: folderName(repo), title: repo }
        : { name: "repository not set", title: "" },
      branch: `new worktree from ${workingFolder.branch}`,
    };
  }
  return {
    folder: { name: folderName(workingFolder.path), title: workingFolder.path },
    branch: branchText(state),
  };
}
