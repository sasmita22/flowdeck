import { modelChoices, type Choice } from "../../../core/flow/choices.js";
import type { BranchState } from "../branch-store.js";

export type BranchSelect = {
  disabled: boolean;
  options: Choice[];
  error: string | null;
};

const hint = (label: string, error: string | null = null): BranchSelect => ({
  disabled: true,
  options: [{ value: "", label }],
  error,
});

export const withCurrent = (choices: readonly Choice[], value: string): Choice[] =>
  value === "" || choices.some((choice) => choice.value === value)
    ? [...choices]
    : [{ value, label: value }, ...choices];

export const branchSelect = ({
  repo,
  value,
  branches,
}: {
  repo: string;
  value: string;
  branches: Pick<BranchState, "repo" | "branches" | "error">;
}): BranchSelect => {
  const wanted = repo.trim();
  if (wanted === "") return hint("Choose a repository first");
  if (branches.repo !== wanted) return hint("Loading branches…");
  if (branches.error !== null) return hint("No branches", branches.error);
  if (branches.branches === null) return hint("Loading branches…");
  const listed = branches.branches.map((branch) => ({ value: branch, label: branch }));
  return {
    disabled: false,
    options:
      value === "" ? [{ value: "", label: "Choose…" }, ...listed] : withCurrent(listed, value),
    error: null,
  };
};

export const buildModelChoices: readonly Choice[] = [
  { value: "", label: "The session's default" },
  ...modelChoices,
];
