import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { SQLiteMetadataStore } from "../../packages/core/src/store/sqlite.js";
import type { ServerBoxMetadata } from "../../packages/core/src/types.js";

function sampleMetadata(id: string): ServerBoxMetadata {
  return {
    id,
    sandboxId: `sandbox-${id}`,
    state: "running",
    url: `https://example.test/${id}`,
    previewToken: "preview-token",
    username: "opencode",
    password: "password",
    providers: ["opencode"],
    labels: { env: "test" },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

describe("SQLiteMetadataStore", () => {
  it("persists and retrieves metadata", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "serverbox-store-"));
    const dbPath = path.join(tempDir, "store.db");

    const store = new SQLiteMetadataStore(dbPath);
    const item = sampleMetadata("instance-1");

    await store.set(item);
    const found = await store.get(item.id);

    expect(found).toEqual(item);

    const listed = await store.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe(item.id);

    await store.delete(item.id);
    expect(await store.get(item.id)).toBeNull();

    await store.close();
  });
});
