import { useEffect } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import type { Actions } from "../actions.js";
import { formatWhen, shortHash } from "../format.js";
import { Icon } from "../icons.js";
import { selectBuildCards, type BuildCard, type LibraryState } from "../library-store.js";
import { arrange, type NavState } from "../nav-store.js";
import { selectRunDisabled, type RunState } from "../run-store.js";
import type { SaveState } from "../save-store.js";
import { pageTestIds } from "../test-ids.js";
import { Empty, PageHead } from "./page-head.js";

const versionText = (card: Pick<BuildCard, "version">) =>
  card.version === null ? "" : `v${card.version}`;

function useRunBlocked(run: StoreApi<RunState>, save: StoreApi<SaveState>) {
  const starting = useStore(run, (state) => state.starting);
  const snapshot = useStore(run, (state) => state.snapshot);
  const saving = useStore(save, (state) => state.saving);
  return selectRunDisabled({ starting, snapshot }, { saving });
}

function BuildFiles({
  hash,
  nav,
  library,
  run,
  save,
  actions,
}: {
  hash: string;
  nav: StoreApi<NavState>;
  library: StoreApi<LibraryState>;
  run: StoreApi<RunState>;
  save: StoreApi<SaveState>;
  actions: Actions;
}) {
  const files = useStore(library, (state) => (state.files?.hash === hash ? state.files : null));
  const builds = useStore(library, (state) => state.builds);
  const flows = useStore(library, (state) => state.flows);
  const card = selectBuildCards({ flows, builds }).find((build) => build.hash === hash);
  const blocked = useRunBlocked(run, save);

  useEffect(() => {
    void library.getState().openFiles(hash);
  }, [library, hash]);

  const shown = files?.list.find((file) => file.path === files.selected);
  return (
    <>
      <header className="fd-page-head">
        <nav className="fd-crumbs" aria-label="Breadcrumb">
          <button
            className="fd-crumb"
            data-testid={pageTestIds.buildBack}
            onClick={() => nav.getState().go({ name: "builds" })}
          >
            Builds
          </button>
          <span aria-hidden="true">/</span>
          <h1 className="fd-page-title fd-page-title-small" data-testid={pageTestIds.title}>
            {card?.name ?? "Build"} {card === undefined ? "" : versionText(card)}
            <code className="fd-hash">{shortHash(hash)}</code>
          </h1>
        </nav>
        <div className="fd-page-bar">
          <p className="fd-page-note">
            Locked. These are the exact files a run of this build uses.
          </p>
          <button
            className="fd-btn fd-btn-primary"
            data-testid={pageTestIds.buildDetailRun}
            disabled={blocked}
            onClick={() => void actions.runBuild(hash)}
          >
            Run
          </button>
        </div>
      </header>
      <div className="fd-files">
        <ul className="fd-file-list" aria-label="Files">
          {files?.list.map((file) => (
            <li key={file.path}>
              <button
                className="fd-file-row"
                data-testid={pageTestIds.buildFile(file.path)}
                aria-current={file.path === files.selected ? "true" : undefined}
                onClick={() => library.getState().selectFile(file.path)}
              >
                <Icon name="file" />
                <span className="fd-ellipsis">{file.path}</span>
              </button>
            </li>
          ))}
        </ul>
        <pre className="fd-file-content" data-testid={pageTestIds.buildFileContent} tabIndex={0}>
          {shown?.content ?? ""}
        </pre>
      </div>
    </>
  );
}

export function BuildsPage({
  hash,
  nav,
  library,
  run,
  save,
  actions,
}: {
  hash: string | undefined;
  nav: StoreApi<NavState>;
  library: StoreApi<LibraryState>;
  run: StoreApi<RunState>;
  save: StoreApi<SaveState>;
  actions: Actions;
}) {
  const builds = useStore(library, (state) => state.builds);
  const flows = useStore(library, (state) => state.flows);
  const loaded = useStore(library, (state) => state.loaded);
  const query = useStore(nav, (state) => state.query);
  const sort = useStore(nav, (state) => state.sort);
  const blocked = useRunBlocked(run, save);
  if (hash !== undefined) {
    return (
      <BuildFiles hash={hash} nav={nav} library={library} run={run} save={save} actions={actions} />
    );
  }
  const cards = arrange(selectBuildCards({ flows, builds }), { query, sort }, (card) => card.name);
  return (
    <>
      <PageHead title="Builds" nav={nav} searchLabel="Search builds" />
      {loaded && builds.length === 0 && (
        <Empty>No builds yet. Build a saved blueprint from its card or from the editor.</Empty>
      )}
      <div className="fd-cards">
        {cards.map((card) => (
          <article
            key={card.hash}
            className="fd-card"
            data-testid={pageTestIds.buildCard(card.hash)}
          >
            <div className="fd-card-top">
              <button
                className="fd-card-name"
                data-testid={pageTestIds.buildOpen(card.hash)}
                title="See its files"
                onClick={() => nav.getState().go({ name: "builds", hash: card.hash })}
              >
                {card.name} <span className="fd-muted">{versionText(card)}</span>
              </button>
            </div>
            <div className="fd-card-meta">
              <span>Built {formatWhen(card.createdAt)}</span>
              <code className="fd-hash">{shortHash(card.hash)}</code>
            </div>
            <div className="fd-card-actions">
              <button
                className="fd-btn"
                data-testid={pageTestIds.buildRun(card.hash)}
                disabled={blocked}
                onClick={() => void actions.runBuild(card.hash)}
              >
                Run
              </button>
            </div>
          </article>
        ))}
      </div>
    </>
  );
}
