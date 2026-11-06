import { useRef, type KeyboardEvent, type ReactNode } from "react";

export interface TabDef<T extends string> {
  id: T;
  label: string;
  indicator?: "dot" | "pulse" | null;
}

const TAB_BASE =
  "-mb-px inline-flex items-center gap-2 border-b-2 px-3 py-2 text-sm font-medium transition-colors " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-500";
const TAB_SELECTED = "border-accent-600 text-accent-700 dark:border-accent-400 dark:text-accent-300";
const TAB_IDLE =
  "border-transparent text-zinc-500 hover:border-zinc-300 hover:text-zinc-800 " +
  "dark:text-zinc-400 dark:hover:border-zinc-600 dark:hover:text-zinc-200";

export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  idPrefix = "tabs",
  label,
}: {
  tabs: TabDef<T>[];
  value: T;
  onChange: (id: T) => void;
  idPrefix?: string;
  label: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  function select(index: number) {
    const next = (index + tabs.length) % tabs.length;
    onChange(tabs[next].id);
    refs.current[next]?.focus();
  }

  function onKeyDown(e: KeyboardEvent, index: number) {
    switch (e.key) {
      case "ArrowRight":
        select(index + 1);
        break;
      case "ArrowLeft":
        select(index - 1);
        break;
      case "Home":
        select(0);
        break;
      case "End":
        select(tabs.length - 1);
        break;
      default:
        return;
    }
    e.preventDefault();
  }

  return (
    <div
      role="tablist"
      aria-label={label}
      className="flex gap-1 border-b border-zinc-200 dark:border-zinc-800"
    >
      {tabs.map((tab, i) => {
        const selected = tab.id === value;
        return (
          <button
            key={tab.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`${idPrefix}-tab-${tab.id}`}
            aria-selected={selected}
            aria-controls={`${idPrefix}-panel-${tab.id}`}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(tab.id)}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={`${TAB_BASE} ${selected ? TAB_SELECTED : TAB_IDLE}`}
          >
            {tab.label}
            {tab.indicator && (
              <>
                <span
                  aria-hidden="true"
                  className={
                    tab.indicator === "pulse"
                      ? "h-2 w-2 rounded-full bg-amber-500 animate-pulse motion-reduce:animate-none dark:bg-amber-400"
                      : "h-2 w-2 rounded-full bg-amber-500 dark:bg-amber-400"
                  }
                />
                {/* Keeps a space between the label and the sr-only text in the accessible name. */}
                {" "}
                <span className="sr-only">{tab.indicator === "pulse" ? " active" : " needs attention"}</span>
              </>
            )}
          </button>
        );
      })}
    </div>
  );
}

export function TabPanel({
  id,
  value,
  idPrefix = "tabs",
  children,
}: {
  id: string;
  value: string;
  idPrefix?: string;
  children: ReactNode;
}) {
  return (
    <div
      role="tabpanel"
      id={`${idPrefix}-panel-${id}`}
      aria-labelledby={`${idPrefix}-tab-${id}`}
      hidden={id !== value}
    >
      {children}
    </div>
  );
}
