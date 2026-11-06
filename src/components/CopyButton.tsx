import { useState } from "react";
import { Button } from "./ui";

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
    <Button variant="ghost" size="sm" icon={copied ? "check" : "copy"} onClick={() => void copy()}>
      {copied ? "Copied" : "Copy"}
    </Button>
  );
}
