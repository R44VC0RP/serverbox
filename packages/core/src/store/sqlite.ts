import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { DEFAULTS } from "../constants.js";
import { ServerBoxError } from "../errors.js";
import type { MetadataStore, ServerBoxMetadata, ServerBoxState } from "../types.js";

interface Row {
  id: string;
  sandbox_id: string;
  state: string;
  url: string | null;
  preview_token: string | null;
  username: string;
  password: string;
  providers: string;
  labels: string;
  created_at: string;
  updated_at: string;
}

function safeParseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function normalizeState(state: string): ServerBoxState {
  const normalized = state.toLowerCase();
  switch (normalized) {
    case "provisioning":
    case "bootstrapping":
    case "running":
    case "stopped":
    case "archived":
    case "error":
    case "destroyed":
      return normalized;
    default:
      return "error";
  }
}

function mapRow(row: Row): ServerBoxMetadata {
  return {
    id: row.id,
    sandboxId: row.sandbox_id,
    state: normalizeState(row.state),
    url: row.url,
    previewToken: row.preview_token,
    username: row.username,
    password: row.password,
    providers: safeParseJson<string[]>(row.providers, []),
    labels: safeParseJson<Record<string, string>>(row.labels, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export class SQLiteMetadataStore implements MetadataStore {
  private readonly db: any;

  constructor(dbPath: string = DEFAULTS.DEFAULT_DB_PATH) {
    const require = createRequire(import.meta.url);

    const isBunRuntime = Boolean((process as { versions?: Record<string, string> }).versions?.bun);

    let DatabaseCtor: (new (filename: string) => any) | null = null;

    if (isBunRuntime) {
      try {
        const sqlite = require("bun:sqlite") as {
          Database?: new (filename: string) => any;
          default?: new (filename: string) => any;
        };

        DatabaseCtor = sqlite.Database ?? sqlite.default ?? (sqlite as unknown as new (filename: string) => any);
      } catch (error) {
        throw ServerBoxError.wrap("STORE_ERROR", error, "Failed to load bun:sqlite runtime module");
      }
    } else {
      try {
        const sqlite = require("node:sqlite") as {
          DatabaseSync?: new (filename: string) => any;
          default?: { DatabaseSync?: new (filename: string) => any };
        };

        DatabaseCtor = sqlite.DatabaseSync ?? sqlite.default?.DatabaseSync ?? null;
      } catch (error) {
        throw ServerBoxError.wrap("STORE_ERROR", error, "Failed to load node:sqlite runtime module");
      }
    }

    if (!DatabaseCtor) {
      throw new ServerBoxError("STORE_ERROR", "No compatible sqlite runtime was found.");
    }

    const directory = path.dirname(dbPath);
    if (!fs.existsSync(directory)) {
      fs.mkdirSync(directory, { recursive: true });
    }

    this.db = new DatabaseCtor(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS instances (
        id TEXT PRIMARY KEY,
        sandbox_id TEXT NOT NULL,
        state TEXT NOT NULL,
        url TEXT,
        preview_token TEXT,
        username TEXT NOT NULL,
        password TEXT NOT NULL,
        providers TEXT NOT NULL,
        labels TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
  }

  async get(id: string): Promise<ServerBoxMetadata | null> {
    try {
      const stmt = this.db.prepare("SELECT * FROM instances WHERE id = ?");
      const row = stmt.get(id) as Row | undefined;
      return row ? mapRow(row) : null;
    } catch (error) {
      throw ServerBoxError.wrap("STORE_ERROR", error, `Failed to fetch instance ${id}`);
    }
  }

  async set(metadata: ServerBoxMetadata): Promise<void> {
    try {
      const stmt = this.db.prepare(`
        INSERT INTO instances (
          id,
          sandbox_id,
          state,
          url,
          preview_token,
          username,
          password,
          providers,
          labels,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          sandbox_id = excluded.sandbox_id,
          state = excluded.state,
          url = excluded.url,
          preview_token = excluded.preview_token,
          username = excluded.username,
          password = excluded.password,
          providers = excluded.providers,
          labels = excluded.labels,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at
      `);

      stmt.run(
        metadata.id,
        metadata.sandboxId,
        metadata.state,
        metadata.url,
        metadata.previewToken,
        metadata.username,
        metadata.password,
        JSON.stringify(metadata.providers),
        JSON.stringify(metadata.labels),
        metadata.createdAt,
        metadata.updatedAt
      );
    } catch (error) {
      throw ServerBoxError.wrap("STORE_ERROR", error, `Failed to upsert instance ${metadata.id}`);
    }
  }

  async list(): Promise<ServerBoxMetadata[]> {
    try {
      const stmt = this.db.prepare("SELECT * FROM instances ORDER BY created_at DESC");
      const rows = stmt.all() as unknown as Row[];
      return rows.map(mapRow);
    } catch (error) {
      throw ServerBoxError.wrap("STORE_ERROR", error, "Failed to list instances");
    }
  }

  async delete(id: string): Promise<void> {
    try {
      const stmt = this.db.prepare("DELETE FROM instances WHERE id = ?");
      stmt.run(id);
    } catch (error) {
      throw ServerBoxError.wrap("STORE_ERROR", error, `Failed to delete instance ${id}`);
    }
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
