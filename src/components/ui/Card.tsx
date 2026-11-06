import type { ReactNode } from "react";

export function Card({
  title,
  description,
  actions,
  padded = true,
  className,
  children,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  padded?: boolean;
  className?: string;
  children?: ReactNode;
}) {
  const surface = "rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900";
  return (
    <section className={className ? `${surface} ${className}` : surface}>
      {title && (
        <header className="flex items-start justify-between gap-3 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{title}</h2>
            {description && <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">{description}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={padded ? "p-4" : undefined}>{children}</div>
    </section>
  );
}
