import { useEffect } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import type { ConnectorSetting, InstalledConnector } from "../../../core/doctor/connectors.js";
import type { LibraryState } from "../library-store.js";
import { pageTestIds } from "../test-ids.js";
import { Empty, PageHead, WithCode } from "./page-head.js";

const statusText: Record<InstalledConnector["status"], string> = {
  ok: "Installed",
  "missing-setting": "Missing a setting",
};

const statusTone: Record<InstalledConnector["status"], string> = {
  ok: "ok",
  "missing-setting": "warn",
};

function Settings({ settings }: { settings: readonly ConnectorSetting[] }) {
  if (settings.length === 0) return null;
  return (
    <ul className="fd-settings">
      {settings.map((setting) => (
        <li key={setting.name} data-set={setting.set}>
          <code>{setting.name}</code>: {setting.set ? "set" : "empty"}
        </li>
      ))}
    </ul>
  );
}

export function DoctorPage({
  library,
  nav,
}: {
  library: StoreApi<LibraryState>;
  nav: Parameters<typeof PageHead>[0]["nav"];
}) {
  const report = useStore(library, (state) => state.doctor);
  const worktrees = useStore(library, (state) => state.worktrees);

  const check = () => void library.getState().diagnose();
  useEffect(check, [library]);
  useEffect(() => {
    void library.getState().listWorktrees();
  }, [library]);

  return (
    <>
      <PageHead title="Doctor" nav={nav} />
      <p className="fd-page-note" data-testid={pageTestIds.doctorScopeBanner}>
        <WithCode text="This lists only your user-level connectors, the ones in Claude Code's user config. Project-level connectors, from a repo's `.mcp.json` or its local settings, aren't listed here." />
      </p>
      <p className="fd-page-note">
        Checks the connectors (MCP servers) Claude Code has for your user on this Mac, the same list
        builds use. Setting values are never shown.
      </p>
      <section className="fd-section">
        <div className="fd-section-head">
          <h2>Installed on this Mac</h2>
          <button className="fd-btn" data-testid={pageTestIds.doctorRecheck} onClick={check}>
            Check again
          </button>
        </div>
        {report !== null && report.installed.length === 0 && (
          <Empty>Claude Code has no connectors for your user.</Empty>
        )}
        <ul className="fd-doctor-list">
          {report?.installed.map((connector) => (
            <li
              key={connector.name}
              className="fd-doctor-row"
              data-testid={pageTestIds.doctorInstalled(connector.name)}
              data-status={connector.status}
            >
              <div className="fd-doctor-line">
                <strong>{connector.name}</strong>
                <span className={`fd-badge fd-badge-${statusTone[connector.status]}`}>
                  {statusText[connector.status]}
                </span>
              </div>
              <Settings settings={connector.settings} />
            </li>
          ))}
        </ul>
      </section>
      <section className="fd-section" data-testid={pageTestIds.doctorWorktrees}>
        <div className="fd-section-head">
          <h2>Worktrees left by older builds</h2>
        </div>
        <p className="fd-page-note">
          Folders under worktrees/ that runs made before builds had their own workspace. Flowdeck no
          longer uses them and never removes them; delete them yourself once nothing in them is
          needed.
        </p>
        {worktrees !== null && worktrees.length === 0 && <Empty>None.</Empty>}
        <ul className="fd-doctor-list">
          {worktrees?.map((path) => (
            <li key={path} className="fd-doctor-row">
              <code>{path}</code>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
