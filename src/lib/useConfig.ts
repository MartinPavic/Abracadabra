import { useCallback, useEffect, useState } from "react";
import { type AppConfig, getConfig, saveConfig } from "./api";

export function useConfig() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setConfig(await getConfig());
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const update = useCallback(async (next: AppConfig) => {
    await saveConfig(next);
    setConfig(next);
  }, []);

  return { config, loading, error, reload, update };
}
