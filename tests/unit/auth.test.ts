import { describe, expect, it } from "vitest";

import {
  buildAuthRecord,
  buildOpenCodeConfig,
  collectProviderEnv,
  normalizeProviderAuth
} from "../../packages/sdk/src/auth.js";

describe("auth helpers", () => {
  it("uses OpenCode Zen env key as default auth", () => {
    const entries = normalizeProviderAuth(undefined, {
      OPENCODE_ZEN_API_KEY: "zen-key"
    } as NodeJS.ProcessEnv);

    expect(entries).toEqual([{ provider: "opencode", apiKey: "zen-key" }]);
  });

  it("throws when no auth is provided and no Zen key exists", () => {
    expect(() => normalizeProviderAuth(undefined, {} as NodeJS.ProcessEnv)).toThrow(
      "No provider auth supplied"
    );
  });

  it("deduplicates providers and keeps the latest config", () => {
    const entries = normalizeProviderAuth([
      { provider: "opencode", apiKey: "old" },
      { provider: "opencode", apiKey: "new" },
      { provider: "openai", apiKey: "openai-key" }
    ]);

    expect(entries).toEqual([
      { provider: "opencode", apiKey: "new", env: undefined },
      { provider: "openai", apiKey: "openai-key", env: undefined }
    ]);
  });

  it("builds auth record and merges provider env", () => {
    const entries = normalizeProviderAuth([
      {
        provider: "opencode",
        apiKey: "zen",
        env: { SHARED: "one", OPENCODE_REGION: "us" }
      },
      {
        provider: "amazon-bedrock",
        env: { SHARED: "two", AWS_REGION: "us-east-1" }
      }
    ]);

    expect(buildAuthRecord(entries)).toEqual({ opencode: "zen" });
    expect(collectProviderEnv(entries)).toEqual({
      SHARED: "two",
      OPENCODE_REGION: "us",
      AWS_REGION: "us-east-1"
    });
  });

  it("attaches schema when building opencode config", () => {
    const config = buildOpenCodeConfig({ model: "opencode/gpt-5.1-codex" });
    expect(config).toEqual({
      $schema: "https://opencode.ai/config.json",
      model: "opencode/gpt-5.1-codex"
    });
  });
});
