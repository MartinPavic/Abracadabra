import type { ReactNode } from "react";
import { Icon, type IconName } from "./Icon";

export type NoticeTone = "info" | "success" | "warning" | "danger";

const TONES: Record<NoticeTone, { box: string; icon: IconName; iconClass: string }> = {
  info: {
    box: "border-blue-200 bg-blue-50 text-blue-900 dark:border-blue-900/60 dark:bg-blue-950/40 dark:text-blue-200",
    icon: "info",
    iconClass: "text-blue-600 dark:text-blue-400",
  },
  success: {
    box: "border-green-200 bg-green-50 text-green-900 dark:border-green-900/60 dark:bg-green-950/40 dark:text-green-200",
    icon: "check",
    iconClass: "text-green-600 dark:text-green-400",
  },
  warning: {
    box: "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200",
    icon: "alert",
    iconClass: "text-amber-600 dark:text-amber-400",
  },
  danger: {
    box: "border-red-200 bg-red-50 text-red-900 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-200",
    icon: "alert",
    iconClass: "text-red-600 dark:text-red-400",
  },
};

export function Notice({
  tone = "info",
  title,
  actions,
  children,
}: {
  tone?: NoticeTone;
  title?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  const { box, icon, iconClass } = TONES[tone];
  const role = tone === "danger" || tone === "warning" ? "alert" : "status";
  return (
    <div
      role={role}
      className={`flex flex-col gap-3 rounded-lg border px-3 py-2.5 text-sm sm:flex-row sm:items-center ${box}`}
    >
      <div className="flex min-w-0 flex-1 gap-2.5">
        <Icon name={icon} className={`mt-0.5 size-4 shrink-0 ${iconClass}`} />
        <div className="min-w-0">
          {title && <p className="font-semibold">{title}</p>}
          {children && <div>{children}</div>}
        </div>
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}
