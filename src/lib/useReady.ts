import { useEffect, useState } from "react";
import { checkReady, type ReadyItem } from "./api";

/** Readiness of the source; null while loading or when the check itself failed (never blocks the user). */
export function useReady(sourceId: string | null): ReadyItem[] | null {
  const [items, setItems] = useState<ReadyItem[] | null>(null);

  useEffect(() => {
    setItems(null);
    if (!sourceId) return;
    let active = true;
    let latest = 0;
    // A failed check may be a denied keychain prompt; re-checking on focus would prompt again.
    let failed = false;
    const check = () => {
      const call = ++latest;
      checkReady(sourceId).then(
        (result) => {
          if (active && call === latest) setItems(result);
        },
        () => {
          failed = true;
          if (active && call === latest) setItems(null);
        },
      );
    };
    const onFocus = () => {
      if (!failed) check();
    };
    check();
    window.addEventListener("focus", onFocus);
    return () => {
      active = false;
      window.removeEventListener("focus", onFocus);
    };
  }, [sourceId]);

  return items;
}
