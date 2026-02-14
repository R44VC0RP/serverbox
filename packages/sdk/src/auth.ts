import { DEFAULTS, ServerBoxError, type OpenCodeConfig, type ProviderAuth } from "@serverbox/core";

function hasKeys(value: Record<string, string> | undefined): boolean {
  return Boolean(value && Object.keys(value).length > 0);
}

export function normalizeProviderAuth(
  authInput: ProviderAuth | ProviderAuth[] | undefined,
  env: NodeJS.ProcessEnv = process.env
): ProviderAuth[] {
  if (!authInput) {
    const zenKey = env.OPENCODE_ZEN_API_KEY ?? env.OPENCODE_API_KEY;
    if (!zenKey) {
      throw new ServerBoxError(
        "MISSING_AUTH",
        "No provider auth supplied. Provide auth in create() or set OPENCODE_ZEN_API_KEY for default OpenCode Zen auth."
      );
    }

    return [{ provider: DEFAULTS.DEFAULT_PROVIDER_ID, apiKey: zenKey }];
  }

  const entries = Array.isArray(authInput) ? authInput : [authInput];
  if (entries.length === 0) {
    throw new ServerBoxError("MISSING_AUTH", "At least one auth provider must be configured.");
  }

  const map = new Map<string, ProviderAuth>();

  for (const entry of entries) {
    const provider = entry.provider.trim();
    if (!provider) {
      throw new ServerBoxError("INVALID_CONFIG", "Provider id cannot be empty.");
    }

    if (!entry.apiKey && !hasKeys(entry.env)) {
      throw new ServerBoxError(
        "INVALID_CONFIG",
        `Provider '${provider}' requires an apiKey or env values.`
      );
    }

    map.set(provider, {
      provider,
      apiKey: entry.apiKey,
      env: entry.env ? { ...entry.env } : undefined
    });
  }

  return [...map.values()];
}

export function buildAuthRecord(entries: ProviderAuth[]): Record<string, string> {
  const output: Record<string, string> = {};
  for (const entry of entries) {
    if (entry.apiKey) {
      output[entry.provider] = entry.apiKey;
    }
  }
  return output;
}

export function collectProviderEnv(entries: ProviderAuth[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const entry of entries) {
    if (!entry.env) continue;
    Object.assign(env, entry.env);
  }
  return env;
}

export function buildOpenCodeConfig(config?: OpenCodeConfig): OpenCodeConfig | null {
  if (!config) return null;

  return {
    $schema: "https://opencode.ai/config.json",
    ...config
  };
}
