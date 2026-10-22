import { useState } from "react";

/** Copies `text` to the clipboard and briefly says so. */
export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <button
      type="button"
      onClick={() => void copy()}
      className="ml-auto rounded px-2 py-0.5 text-[10px] font-medium normal-case text-zinc-500 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-900"
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}
