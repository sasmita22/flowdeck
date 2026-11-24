import type { FlowSummary } from "../../core/flow/flow-store.js";
import { pageTestIds, type UsedByScope } from "./test-ids.js";

export function UsedByList({
  scope,
  libraryId,
  users,
  onOpen,
}: {
  scope: UsedByScope;
  libraryId: string;
  users: readonly FlowSummary[];
  onOpen: (flowId: string) => void;
}) {
  if (users.length === 0) {
    return (
      <p className="fd-hint" data-testid={pageTestIds.usedByNone(scope, libraryId)}>
        Not used by any blueprint.
      </p>
    );
  }
  return (
    <ul
      data-testid={pageTestIds.usedByList(scope, libraryId)}
      aria-label="Used by"
      style={{
        margin: 0,
        padding: 0,
        listStyle: "none",
        display: "flex",
        flexDirection: "column",
        gap: 2,
      }}
    >
      {users.map((user) => (
        <li key={user.flowId}>
          <button
            className="fd-link"
            data-testid={pageTestIds.usedByOpen(scope, libraryId, user.flowId)}
            title={`Open ${user.name}`}
            onClick={() => onOpen(user.flowId)}
          >
            {user.name}
          </button>
        </li>
      ))}
    </ul>
  );
}
