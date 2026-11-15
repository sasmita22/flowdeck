import { useMemo, useState } from "react";
import { fileTree, type FileTreeNode } from "../../../core/run/file-tree.js";
import { Icon } from "../icons.js";
import { pageTestIds } from "../test-ids.js";

export type FileSelection = { selected: string | null; onSelect: (path: string) => void };

function FileRow({
  node,
  selection,
}: {
  node: FileTreeNode;
  selection: FileSelection | undefined;
}) {
  if (selection === undefined) {
    return (
      <span
        className="fd-file-row fd-tree-name"
        data-testid={pageTestIds.buildFile(node.path)}
        title={node.path}
      >
        <Icon name="file" />
        <span className="fd-ellipsis">{node.label}</span>
      </span>
    );
  }
  return (
    <button
      className="fd-file-row"
      data-testid={pageTestIds.buildFile(node.path)}
      aria-current={node.path === selection.selected ? "true" : undefined}
      title={node.path}
      onClick={() => selection.onSelect(node.path)}
    >
      <Icon name="file" />
      <span className="fd-ellipsis">{node.label}</span>
    </button>
  );
}

function FolderRow({
  node,
  selection,
}: {
  node: FileTreeNode;
  selection: FileSelection | undefined;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        className="fd-file-row"
        data-testid={pageTestIds.buildFolder(node.path)}
        aria-expanded={open}
        title={node.path}
        onClick={() => setOpen(!open)}
      >
        <Icon name="folder" />
        <span className="fd-ellipsis">{node.label}</span>
      </button>
      {open && <TreeLevel nodes={node.children} selection={selection} nested />}
    </>
  );
}

function TreeLevel({
  nodes,
  selection,
  nested,
}: {
  nodes: FileTreeNode[];
  selection: FileSelection | undefined;
  nested?: boolean | undefined;
}) {
  return (
    <ul
      className={nested === true ? "fd-tree-level" : "fd-file-list fd-tree"}
      aria-label={nested === true ? undefined : "Files"}
    >
      {nodes.map((node) => (
        <li key={node.path}>
          {node.kind === "folder" ? (
            <FolderRow node={node} selection={selection} />
          ) : (
            <FileRow node={node} selection={selection} />
          )}
        </li>
      ))}
    </ul>
  );
}

export function BuildTree({
  paths,
  selection,
}: {
  paths: string[];
  selection?: FileSelection | undefined;
}) {
  const nodes = useMemo(() => fileTree(paths), [paths]);
  return <TreeLevel nodes={nodes} selection={selection} />;
}
