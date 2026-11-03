import type { BuildConfig } from "../../core/flow/schema.js";

export const shortHash = (hash: string): string => hash.slice(0, 7);

const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const twoDigits = (value: number) => String(value).padStart(2, "0");

export const formatWhen = (at: string | number): string => {
  const date = new Date(at);
  return `${months[date.getMonth()]} ${date.getDate()}, ${twoDigits(date.getHours())}:${twoDigits(date.getMinutes())}`;
};

export const formatDuration = (ms: number): string => {
  const seconds = Math.floor(ms / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
};

export const formatTokens = (tokens: number): string => {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M tokens`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k tokens`;
  return `${tokens} tokens`;
};

export const formatCost = (cost: number | null): string =>
  cost === null ? "No cost recorded" : `$${cost.toFixed(2)}`;

const lastPart = (path: string) => {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1) || path;
};

export const folderText = (buildConfig: BuildConfig | null): string => {
  if (buildConfig === null) return "No folder yet";
  return buildConfig.repo ? `${lastPart(buildConfig.repo)} · new worktree` : "New worktree";
};
