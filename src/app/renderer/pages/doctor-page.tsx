import { useEffect, useState } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import type { ConnectorSetting, NeededConnector } from "../../../core/doctor/connectors.js";
import type { CanvasState } from "../canvas/store.js";
import type { LibraryState } from "../library-store.js";
import type { SaveState } from "../save-store.js";
import { pageTestIds } from "../test-ids.js";
import { Empty, PageHead, WithCode } from "./page-head.js";

const statusText: Record<NeededConnector["status"], string> = {
  ok: "Installed",
  missing: "Not installed",
  "missing-setting": "Missing a setting",
};

const statusTone: Record<NeededConnector["status"], string> = {
  ok: "ok",
  missing: "fail",
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
  save,
  canvas,
  nav,
}: {
  library: StoreApi<LibraryState>;
  save: StoreApi<SaveState>;
  canvas: StoreApi<CanvasState>;
  nav: Parameters<typeof PageHead>[0]["nav"];
}) {
  const report = useStore(library, (state) => state.doctor);
  const flows = useStore(library, (state) => state.flows);
  const openId = useStore(save, (state) => state.flowId);
  const openName = useStore(save, (state) => state.name);
  const openConnectors = useStore(canvas, (state) => state.flow.session.connectors);
  const [chosen, setChosen] = useState<string>("");
  const flowId = chosen === "" ? null : chosen;
  const name =
    flowId === null ? openName : (flows.find((flow) => flow.flowId === flowId)?.name ?? "");

  const worktrees = useStore(library, (state) => state.worktrees);

  const check = () => void library.getState().diagnose(flowId, openConnectors);
  useEffect(check, [library, flowId, openConnectors]);
  useEffect(() => {
    void library.getState().listWorktrees();
  }, [library]);

  return (
    <>
      <PageHead title="Doctor" nav={nav} />
      <p className="fd-page-note">
        Checks the connectors (MCP servers) Claude Code has for your user on this Mac, the same list
        builds use. Setting values are never shown.
      </p>
      <section className="fd-section">
        <div className="fd-section-head">
          <h2>Needed by</h2>
          <select
            className="fd-select"
            data-testid={pageTestIds.doctorBlueprint}
            aria-label="Blueprint to check"
            value={chosen}
            onChange={(event) => setChosen(event.target.value)}
          >
            <option value="">{openName} (open)</option>
            {flows
              .filter((flow) => flow.flowId !== openId && flow.versions > 0)
              .map((flow) => (
                <option key={flow.flowId} value={flow.flowId}>
                  {flow.name}
                </option>
              ))}
          </select>
          <button className="fd-btn" data-testid={pageTestIds.doctorRecheck} onClick={check}>
            Check again
          </button>
        </div>
        {report !== null && report.needed.length === 0 && (
          <Empty>{name} needs no connectors.</Empty>
        )}
        <ul className="fd-doctor-list">
          {report?.needed.map((connector) => (
            <li
              key={connector.name}
              className="fd-doctor-row"
              data-testid={pageTestIds.doctorNeeded(connector.name)}
              data-status={connector.status}
            >
              <div className="fd-doctor-line">
                <strong>{connector.name}</strong>
                <span className={`fd-badge fd-badge-${statusTone[connector.status]}`}>
                  {statusText[connector.status]}
                </span>
              </div>
              <Settings settings={connector.settings} />
              {connector.fix !== null && (
                <p className="fd-fix" data-testid={pageTestIds.doctorFix(connector.name)}>
                  <WithCode text={connector.fix} />
                </p>
              )}
            </li>
          ))}
        </ul>
      </section>
      <section className="fd-section">
        <div className="fd-section-head">
          <h2>Installed on this Mac</h2>
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
