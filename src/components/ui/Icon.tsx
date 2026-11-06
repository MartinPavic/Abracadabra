import type { ReactNode } from "react";

export type IconName =
  | "tasks"
  | "history"
  | "settings"
  | "sun"
  | "moon"
  | "check"
  | "x"
  | "alert"
  | "info"
  | "play"
  | "list"
  | "refresh"
  | "external"
  | "copy"
  | "chevron-right"
  | "chevron-down"
  | "branch"
  | "folder"
  | "merge"
  | "search"
  | "sparkles"
  | "trash"
  | "stop"
  | "edit"
  | "file";

const GLYPHS: Record<IconName, ReactNode> = {
  tasks: (
    <>
      <path d="M4 6l1.5 1.5L8 5" />
      <path d="M4 12l1.5 1.5L8 11" />
      <path d="M4 18l1.5 1.5L8 17" />
      <path d="M12 6h8M12 12h8M12 18h8" />
    </>
  ),
  history: (
    <>
      <path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1L3.5 8.5" />
      <path d="M3.5 4v4.5H8" />
      <path d="M12 8v4l2.5 2" />
    </>
  ),
  settings: (
    <>
      <path d="M4 7h9M17 7h3M4 17h3M11 17h9" />
      <circle cx="15" cy="7" r="2" />
      <circle cx="9" cy="17" r="2" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4" />
    </>
  ),
  moon: <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  x: <path d="M6 6l12 12M18 6L6 18" />,
  alert: (
    <>
      <path d="M12 4L2.5 20h19L12 4z" />
      <path d="M12 10v4M12 17.2v.1" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 7.7v.1" />
    </>
  ),
  play: <path d="M7 4.5v15l12-7.5-12-7.5z" />,
  list: <path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" />,
  refresh: (
    <>
      <path d="M20 11a8 8 0 0 0-14.5-3.5L4 9" />
      <path d="M4 4v5h5" />
      <path d="M4 13a8 8 0 0 0 14.5 3.5L20 15" />
      <path d="M20 20v-5h-5" />
    </>
  ),
  external: (
    <>
      <path d="M14 4h6v6" />
      <path d="M20 4l-9 9" />
      <path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
    </>
  ),
  copy: (
    <>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V6a2 2 0 0 1 2-2h8" />
    </>
  ),
  "chevron-right": <path d="M9 6l6 6-6 6" />,
  "chevron-down": <path d="M6 9l6 6 6-6" />,
  branch: (
    <>
      <circle cx="6" cy="5.5" r="2" />
      <circle cx="6" cy="18.5" r="2" />
      <circle cx="18" cy="9" r="2" />
      <path d="M6 7.5v9M18 11c0 4-6 3-11 6.5" />
    </>
  ),
  folder: <path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />,
  merge: (
    <>
      <circle cx="6" cy="5.5" r="2" />
      <circle cx="6" cy="18.5" r="2" />
      <circle cx="18" cy="14" r="2" />
      <path d="M6 7.5v9M6 7.5c0 4 4 6.5 10 6.5" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M20 20l-4.3-4.3" />
    </>
  ),
  sparkles: (
    <>
      <path d="M10 4l1.8 5.2L17 11l-5.2 1.8L10 18l-1.8-5.2L3 11l5.2-1.8L10 4z" />
      <path d="M18 3v4M16 5h4M18 17v4M16 19h4" />
    </>
  ),
  trash: (
    <>
      <path d="M4 7h16M10 7V4.5h4V7" />
      <path d="M6 7l1 12.5a1 1 0 0 0 1 .9h8a1 1 0 0 0 1-.9L18 7" />
      <path d="M10 11v6M14 11v6" />
    </>
  ),
  stop: <path d="M8 6h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z" />,
  edit: (
    <>
      <path d="M4 20h4L19 9a2.1 2.1 0 0 0-4-4L4 16v4z" />
      <path d="M14 6l4 4" />
    </>
  ),
  file: (
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5z" />
      <path d="M14 3v5h5M9 13h6M9 17h6" />
    </>
  ),
};

export function Icon({
  name,
  className = "size-4",
  title,
}: {
  name: IconName;
  className?: string;
  title?: string;
}) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      {...(title ? { role: "img" } : { "aria-hidden": true })}
    >
      {title && <title>{title}</title>}
      {GLYPHS[name]}
    </svg>
  );
}
