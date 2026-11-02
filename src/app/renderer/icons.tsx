export type IconName =
  | "plus"
  | "search"
  | "blueprints"
  | "builds"
  | "runs"
  | "doctor"
  | "file"
  | "back"
  | "pencil"
  | "folder";

const paths: Record<IconName, string> = {
  plus: "M8 3v10M3 8h10",
  search: "M7 12.5a5.5 5.5 0 1 1 0-11 5.5 5.5 0 0 1 0 11ZM11 11l3.5 3.5",
  blueprints: "M2.5 2.5h4.5v4.5H2.5ZM9 2.5h4.5v4.5H9ZM2.5 9h4.5v4.5H2.5ZM9 9h4.5v4.5H9Z",
  builds: "M8 1.5 14 4.5v7L8 14.5 2 11.5v-7ZM2 4.5 8 7.5l6-3M8 7.5v7",
  runs: "M4.5 2.5v11l9-5.5Z",
  doctor: "M1.5 8.5h3l1.5-4 3 8 1.5-4h4",
  file: "M3.5 1.5h6l3 3v10h-9ZM9.5 1.5v3h3",
  back: "M10 3 5 8l5 5",
  pencil: "M10.5 2.5l3 3-8 8h-3v-3Z",
  folder: "M1.5 4V13h13V5.5H7.5L6 4Z",
};

export function Icon({ name }: { name: IconName }) {
  return (
    <svg
      className="fd-icon"
      width="16"
      height="16"
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d={paths[name]}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
