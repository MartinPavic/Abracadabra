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
    const check = () => {
      const call = ++latest;
      checkReady(sourceId).then(
        (result) => {
          if (active && call === latest) setItems(result);
        },
        () => {
          if (active && call === latest) setItems(null);
        },
      );
    };
    check();
    window.addEventListener("focus", check);
    return () => {
      active = false;
      window.removeEventListener("focus", check);
    };
  }, [sourceId]);

  return items;
}
