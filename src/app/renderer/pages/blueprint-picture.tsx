import { useState, type CSSProperties } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import type { SnapshotKey } from "../../../core/run/store.js";
import { selectPicture, type LibraryState } from "../library-store.js";
import { pageTestIds } from "../test-ids.js";

const pictureStyle: CSSProperties = { display: "block", maxWidth: "100%", marginTop: 8 };

const svgUrl = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

export function BlueprintPicture({
  library,
  pictureKey,
  testId,
}: {
  library: StoreApi<LibraryState>;
  pictureKey: SnapshotKey;
  testId: string;
}) {
  const [open, setOpen] = useState(false);
  const picture = useStore(library, (state) => selectPicture(state, pictureKey));

  const toggle = () => {
    if (!open && picture === undefined) void library.getState().loadPicture(pictureKey);
    setOpen(!open);
  };

  return (
    <section aria-label="Blueprint at build time">
      <button
        className="fd-btn"
        data-testid={pageTestIds.buildPictureToggle(testId)}
        aria-expanded={open}
        onClick={toggle}
      >
        Blueprint at build time
      </button>
      {open && typeof picture === "string" && (
        <img
          alt="Blueprint at build time"
          src={svgUrl(picture)}
          style={pictureStyle}
          data-testid={pageTestIds.buildPictureImage(testId)}
        />
      )}
      {open && picture === null && (
        <p className="fd-muted" data-testid={pageTestIds.buildPictureEmpty(testId)}>
          No picture for this build
        </p>
      )}
    </section>
  );
}
