import { type AppConfig, type GitProvider, type GitSourceConfig, removeToken, setToken } from "./api";

export interface NewGitSource {
  name: string;
  provider: GitProvider;
  baseUrl: string;
  token: string;
  projectFilter?: string;
}

/** Saves a new source and its token; throws, with the token removed again, if saving fails. */
export async function addGitSource(
  config: AppConfig,
  update: (next: AppConfig) => Promise<void>,
  values: NewGitSource,
): Promise<GitSourceConfig> {
  const source: GitSourceConfig = {
    id: crypto.randomUUID(),
    name: values.name.trim(),
    provider: values.provider,
    baseUrl: values.baseUrl.trim(),
    projectFilter: values.projectFilter?.trim() || null,
  };

  await setToken(source.id, values.token);
  try {
    await update({ ...config, gitSources: [...config.gitSources, source] });
  } catch (err) {
    // Don't leave a token in the keychain for a source that was never saved.
    await removeToken(source.id).catch(() => undefined);
    throw err;
  }
  return source;
}
