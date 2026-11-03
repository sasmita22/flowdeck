import { z } from "zod";

export const folderStateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("branch"), name: z.string() }),
  z.object({ kind: z.literal("detached"), commit: z.string() }),
  z.object({ kind: z.literal("not-a-repo") }),
  z.object({ kind: z.literal("missing") }),
]);

export type FolderState = z.infer<typeof folderStateSchema>;

export type WorkspaceLabel = { folder: { name: string; title: string }; branch: string };
