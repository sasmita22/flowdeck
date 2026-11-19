export type FileTreeNode = {
  name: string;
  label: string;
  path: string;
  kind: "folder" | "file";
  children: FileTreeNode[];
};

const hiddenFolder = "plugin";

const labels: Record<string, string> = {
  "plugin/agents": "Agents",
  "plugin/skills": "Skills",
  "plugin/templates": "Hand-off templates",
  "plugin/hooks": "Hooks",
};

const containerRoot = /^(?:workspace|sessions\/[^/]+)\//;

const node = (path: string, kind: FileTreeNode["kind"]): FileTreeNode => {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const label = labels[path] ?? labels[path.replace(containerRoot, "")] ?? name;
  return { name, label, path, kind, children: [] };
};

const byName = (a: FileTreeNode, b: FileTreeNode): number =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

const sorted = (nodes: FileTreeNode[]): FileTreeNode[] => {
  const folders = nodes.filter((entry) => entry.kind === "folder").sort(byName);
  const files = nodes.filter((entry) => entry.kind === "file").sort(byName);
  return [...folders, ...files].map((entry) => ({ ...entry, children: sorted(entry.children) }));
};

export function fileTree(paths: string[]): FileTreeNode[] {
  const root = node("", "folder");
  const folders = new Map<string, FileTreeNode>([[hiddenFolder, root]]);

  const parentOf = (path: string): FileTreeNode => {
    const slash = path.lastIndexOf("/");
    if (slash === -1) return root;
    const parentPath = path.slice(0, slash);
    const existing = folders.get(parentPath);
    if (existing) return existing;
    const parent = node(parentPath, "folder");
    parentOf(parentPath).children.push(parent);
    folders.set(parentPath, parent);
    return parent;
  };

  for (const path of paths) parentOf(path).children.push(node(path, "file"));
  return sorted(root.children);
}
