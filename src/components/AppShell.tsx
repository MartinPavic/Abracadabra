import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { useTheme } from "../lib/theme";
import appIcon from "../assets/app-icon.png";
import { Button, Icon, type IconName } from "./ui";

const navItems: { to: string; label: string; icon: IconName }[] = [
  { to: "/tasks", label: "Tasks", icon: "tasks" },
  { to: "/settings", label: "Settings", icon: "settings" },
];

export function AppShell({ children }: { children: ReactNode }) {
  const { theme, toggleTheme } = useTheme();

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      <aside className="flex w-56 shrink-0 flex-col border-r border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex items-center gap-2.5 px-4 py-4">
          <img src={appIcon} alt="" className="size-9 shrink-0" />
          <span className="truncate text-base font-semibold text-zinc-900 dark:text-zinc-100">Abracadabra</span>
        </div>
        <nav className="flex flex-col gap-1 px-2">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                `relative flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 ${
                  isActive
                    ? "bg-accent-50 text-accent-700 dark:bg-accent-950/40 dark:text-accent-300"
                    : "text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
                }`
              }
            >
              {({ isActive }) => (
                <>
                  {isActive && (
                    <span
                      aria-hidden="true"
                      className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-accent-600 dark:bg-accent-400"
                    />
                  )}
                  <Icon name={item.icon} />
                  {item.label}
                </>
              )}
            </NavLink>
          ))}
        </nav>
        <div className="mt-auto border-t border-zinc-200 p-2 dark:border-zinc-800">
          <Button
            variant="ghost"
            size="sm"
            icon={theme === "dark" ? "sun" : "moon"}
            onClick={toggleTheme}
            aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            className="w-full justify-start"
          >
            {theme === "dark" ? "Light mode" : "Dark mode"}
          </Button>
        </div>
      </aside>

      <main className="min-w-0 flex-1 scroll-pt-24 overflow-auto">
        <div className="mx-auto flex h-full w-full min-w-0 max-w-6xl flex-col p-6 lg:p-8">{children}</div>
      </main>
    </div>
  );
}
