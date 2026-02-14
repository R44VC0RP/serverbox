import { randomUUID } from "node:crypto";

import {
  DEFAULTS,
  SQLiteMetadataStore,
  ServerBoxError,
  createDefaultLogger,
  generatePassword,
  withRetry,
  type ConnectionInfo,
  type CreateServerBoxOptions,
  type ExecOptions,
  type ExecResult,
  type HealthStatus,
  type ListInstancesOptions,
  type Logger,
  type MetadataStore,
  type ServerBoxConfig,
  type ServerBoxMetadata,
  type ServerBoxState
} from "@serverbox/core";

import { buildAuthRecord, buildOpenCodeConfig, collectProviderEnv, normalizeProviderAuth } from "./auth.js";
import { DaytonaAdapter } from "./daytona.js";
import { ServerBoxInstance } from "./instance.js";
import { bootstrapOpenCodeServer } from "./sandbox/bootstrap.js";
import { checkOpenCodeHealth, buildConnectionHeaders, waitForOpenCodeHealth } from "./sandbox/health.js";
import { downloadFileFromSandbox, executeSandboxCommand, uploadFileToSandbox } from "./sandbox/runtime.js";

function nowIso(): string {
  return new Date().toISOString();
}

function labelsMatch(metadataLabels: Record<string, string>, filter?: Record<string, string>): boolean {
  if (!filter) return true;
  for (const [key, value] of Object.entries(filter)) {
    if (metadataLabels[key] !== value) return false;
  }
  return true;
}

function notFound(error: unknown): boolean {
  if (error instanceof ServerBoxError && error.code === "SANDBOX_NOT_FOUND") return true;
  if (!(error instanceof Error)) return false;
  return error.message.toLowerCase().includes("not found");
}

export class ServerBox {
  private readonly store: MetadataStore;
  private readonly logger: Logger;
  private readonly daytona: DaytonaAdapter;

  constructor(config: ServerBoxConfig = {}) {
    this.logger = config.logger ?? createDefaultLogger((process.env.SERVERBOX_LOG_LEVEL as any) ?? "info");
    this.store = config.store ?? new SQLiteMetadataStore(config.dbPath ?? DEFAULTS.DEFAULT_DB_PATH);
    this.daytona = new DaytonaAdapter(config);
  }

  async create(options: CreateServerBoxOptions = {}): Promise<ServerBoxInstance> {
    const id = options.id ?? randomUUID();
    const authEntries = normalizeProviderAuth(options.auth);
    const providerEnv = collectProviderEnv(authEntries);
    const authRecord = buildAuthRecord(authEntries);
    const opencodeConfig = buildOpenCodeConfig(options.opencode);

    const username = DEFAULTS.OPENCODE_SERVER_USERNAME;
    const password = generatePassword(DEFAULTS.PASSWORD_LENGTH);

    const resources = options.resources
      ? {
          ...(typeof options.resources.cpu === "number" ? { cpu: options.resources.cpu } : {}),
          ...(typeof options.resources.memory === "number" ? { memory: options.resources.memory } : {}),
          ...(typeof options.resources.disk === "number" ? { disk: options.resources.disk } : {})
        }
      : undefined;

    const lifecycle = {
      autoStopInterval: options.lifecycle?.autoStopMinutes ?? DEFAULTS.AUTO_STOP_MINUTES,
      autoArchiveInterval: options.lifecycle?.autoArchiveMinutes ?? DEFAULTS.AUTO_ARCHIVE_MINUTES,
      autoDeleteInterval: options.lifecycle?.autoDeleteMinutes
    };

    const sandboxCreateInput: Record<string, unknown> = {
      id,
      language: DEFAULTS.SANDBOX_LANGUAGE,
      labels: options.labels,
      autoStopInterval: lifecycle.autoStopInterval,
      autoArchiveInterval: lifecycle.autoArchiveInterval,
      envVars: {
        OPENCODE_SERVER_PASSWORD: password,
        OPENCODE_SERVER_USERNAME: username,
        ...providerEnv
      }
    };

    if (typeof lifecycle.autoDeleteInterval === "number") {
      sandboxCreateInput.autoDeleteInterval = lifecycle.autoDeleteInterval;
    }

    if (resources && Object.keys(resources).length > 0) {
      sandboxCreateInput.resources = resources;
    }

    let sandbox: any | undefined;

    try {
      this.logger.info(`Creating sandbox for instance ${id}...`);
      this.logger.debug(
        `Create options instance=${id} providers=${authEntries.map((entry) => entry.provider).join(",")} labels=${JSON.stringify(options.labels ?? {})}`
      );
      sandbox = await withRetry(() => this.daytona.createSandbox(sandboxCreateInput), {
        retries: 3
      });

      const sandboxId = this.daytona.getSandboxId(sandbox);
      this.logger.info(`Sandbox created id=${sandboxId} for instance=${id}`);

      this.logger.info(`Bootstrapping OpenCode server in sandbox ${sandboxId}...`);
      await bootstrapOpenCodeServer(sandbox, {
        username,
        password,
        providerEnv,
        authRecord,
        opencodeConfig,
        installOpenCode: true,
        logger: this.logger
      });

      const preview = await this.daytona.getPreviewLink(sandbox, DEFAULTS.OPENCODE_PORT);

      await waitForOpenCodeHealth(
        {
          baseUrl: preview.url,
          username,
          password,
          previewToken: preview.token
        },
        options.timeout ?? DEFAULTS.HEALTH_TIMEOUT_MS
      );

      const timestamp = nowIso();
      const metadata: ServerBoxMetadata = {
        id,
        sandboxId,
        state: "running",
        url: preview.url,
        previewToken: preview.token,
        username,
        password,
        providers: authEntries.map((entry) => entry.provider),
        labels: options.labels ?? {},
        createdAt: timestamp,
        updatedAt: timestamp
      };

      await this.store.set(metadata);
      this.logger.info(`Instance ${id} is running at ${metadata.url}`);
      return new ServerBoxInstance(this, metadata);
    } catch (error) {
      if (sandbox) {
        try {
          await this.daytona.removeSandbox(sandbox);
        } catch (cleanupError) {
          this.logger.warn("Failed to cleanup sandbox after create error", cleanupError);
        }
      }
      throw ServerBoxError.wrap("CREATE_FAILED", error, `Failed to create ServerBox instance ${id}`);
    }
  }

  async get(id: string): Promise<ServerBoxInstance> {
    const metadata = await this.getMetadataOrThrow(id);
    const synced = await this.syncMetadata(metadata);
    return new ServerBoxInstance(this, synced);
  }

  async list(options: ListInstancesOptions = {}): Promise<ServerBoxMetadata[]> {
    let items = await this.store.list();

    if (options.refresh) {
      items = await Promise.all(
        items.map(async (metadata) => {
          try {
            return await this.syncMetadata(metadata);
          } catch {
            return metadata;
          }
        })
      );
    }

    if (options.state) {
      items = items.filter((item) => item.state === options.state);
    }

    if (options.labels) {
      items = items.filter((item) => labelsMatch(item.labels, options.labels));
    }

    return items;
  }

  async destroy(id: string): Promise<void> {
    const metadata = await this.store.get(id);
    if (!metadata) return;

    this.logger.info(`Destroying instance ${id} (sandbox=${metadata.sandboxId})`);

    try {
      const sandbox = await this.daytona.findSandbox(metadata.sandboxId);
      await this.daytona.removeSandbox(sandbox);
    } catch (error) {
      if (!notFound(error)) {
        throw ServerBoxError.wrap("DAYTONA_API_ERROR", error, `Failed to destroy sandbox ${metadata.sandboxId}`);
      }
    }

    await this.store.delete(id);
    this.logger.info(`Destroyed instance ${id}`);
  }

  async close(): Promise<void> {
    await this.store.close?.();
  }

  async refreshInstance(id: string): Promise<ServerBoxMetadata> {
    const metadata = await this.getMetadataOrThrow(id);
    return this.syncMetadata(metadata);
  }

  async stopInstance(id: string): Promise<ServerBoxMetadata> {
    const metadata = await this.getMetadataOrThrow(id);
    this.logger.info(`Stopping instance ${id} (sandbox=${metadata.sandboxId})`);
    const sandbox = await this.daytona.findSandbox(metadata.sandboxId);

    if (typeof sandbox?.stop !== "function") {
      throw new ServerBoxError("UNSUPPORTED_OPERATION", "Sandbox stop() is unavailable.");
    }

    await sandbox.stop();

    this.logger.info(`Stopped instance ${id}`);

    return this.saveMetadata({
      ...metadata,
      state: "stopped",
      url: null,
      previewToken: null,
      updatedAt: nowIso()
    });
  }

  async resumeInstance(id: string, timeout: number = DEFAULTS.HEALTH_TIMEOUT_MS): Promise<ServerBoxMetadata> {
    const metadata = await this.getMetadataOrThrow(id);
    this.logger.info(`Resuming instance ${id} (sandbox=${metadata.sandboxId})`);
    const sandbox = await this.daytona.findSandbox(metadata.sandboxId);

    if (typeof sandbox?.start !== "function") {
      throw new ServerBoxError("UNSUPPORTED_OPERATION", "Sandbox start() is unavailable.");
    }

    await sandbox.start();

    await bootstrapOpenCodeServer(sandbox, {
      username: metadata.username,
      password: metadata.password,
      providerEnv: {},
      authRecord: null,
      opencodeConfig: null,
      installOpenCode: false,
      logger: this.logger
    });

    const preview = await this.daytona.getPreviewLink(sandbox, DEFAULTS.OPENCODE_PORT);

    await waitForOpenCodeHealth(
      {
        baseUrl: preview.url,
        username: metadata.username,
        password: metadata.password,
        previewToken: preview.token
      },
      timeout
    );

    this.logger.info(`Resumed instance ${id}`);

    return this.saveMetadata({
      ...metadata,
      state: "running",
      url: preview.url,
      previewToken: preview.token,
      updatedAt: nowIso()
    });
  }

  async archiveInstance(id: string): Promise<ServerBoxMetadata> {
    const metadata = await this.getMetadataOrThrow(id);
    this.logger.info(`Archiving instance ${id} (sandbox=${metadata.sandboxId})`);
    const sandbox = await this.daytona.findSandbox(metadata.sandboxId);

    if (typeof sandbox?.archive !== "function") {
      throw new ServerBoxError("UNSUPPORTED_OPERATION", "Sandbox archive() is unavailable.");
    }

    await sandbox.archive();

    this.logger.info(`Archived instance ${id}`);

    return this.saveMetadata({
      ...metadata,
      state: "archived",
      url: null,
      previewToken: null,
      updatedAt: nowIso()
    });
  }

  async healthInstance(id: string): Promise<HealthStatus> {
    const metadata = await this.ensureInstanceRunning(id);

    return checkOpenCodeHealth({
      baseUrl: metadata.url as string,
      username: metadata.username,
      password: metadata.password,
      previewToken: metadata.previewToken
    });
  }

  async execInstance(id: string, command: string, options: ExecOptions = {}): Promise<ExecResult> {
    const metadata = await this.ensureInstanceRunning(id);
    const sandbox = await this.daytona.findSandbox(metadata.sandboxId);
    return executeSandboxCommand(sandbox, command, options);
  }

  async uploadFileInstance(id: string, remotePath: string, content: Buffer | string): Promise<void> {
    const metadata = await this.ensureInstanceRunning(id);
    const sandbox = await this.daytona.findSandbox(metadata.sandboxId);
    await uploadFileToSandbox(sandbox, remotePath, content);
  }

  async downloadFileInstance(id: string, remotePath: string): Promise<Buffer> {
    const metadata = await this.ensureInstanceRunning(id);
    const sandbox = await this.daytona.findSandbox(metadata.sandboxId);
    return downloadFileFromSandbox(sandbox, remotePath);
  }

  buildConnectionInfo(metadata: ServerBoxMetadata): ConnectionInfo {
    if (!metadata.url) {
      throw new ServerBoxError(
        "INSTANCE_NOT_RUNNING",
        `Instance ${metadata.id} is not running. Resume it before requesting connection info.`
      );
    }

    return {
      baseUrl: metadata.url,
      username: metadata.username,
      password: metadata.password,
      previewToken: metadata.previewToken,
      headers: buildConnectionHeaders({
        baseUrl: metadata.url,
        username: metadata.username,
        password: metadata.password,
        previewToken: metadata.previewToken
      })
    };
  }

  private async getMetadataOrThrow(id: string): Promise<ServerBoxMetadata> {
    const metadata = await this.store.get(id);
    if (!metadata) {
      throw new ServerBoxError("INSTANCE_NOT_FOUND", `ServerBox instance '${id}' was not found.`);
    }
    return metadata;
  }

  private async saveMetadata(metadata: ServerBoxMetadata): Promise<ServerBoxMetadata> {
    await this.store.set(metadata);
    return metadata;
  }

  private async ensureInstanceRunning(id: string): Promise<ServerBoxMetadata> {
    const metadata = await this.refreshInstance(id);
    if (metadata.state !== "running" || !metadata.url) {
      throw new ServerBoxError(
        "INSTANCE_NOT_RUNNING",
        `Instance ${id} is ${metadata.state}. Call resume() before performing this operation.`
      );
    }
    return metadata;
  }

  private async syncMetadata(metadata: ServerBoxMetadata): Promise<ServerBoxMetadata> {
    let sandbox: any;
    try {
      sandbox = await this.daytona.findSandbox(metadata.sandboxId);
    } catch (error) {
      if (!notFound(error)) throw error;

      const next = {
        ...metadata,
        state: "destroyed" as ServerBoxState,
        url: null,
        previewToken: null,
        updatedAt: nowIso()
      };

      return this.saveMetadata(next);
    }

    const nextState = this.daytona.getSandboxState(sandbox);
    let nextUrl = metadata.url;
    let nextToken = metadata.previewToken;

    if (nextState === "running") {
      const preview = await this.daytona.getPreviewLink(sandbox, DEFAULTS.OPENCODE_PORT);
      nextUrl = preview.url;
      nextToken = preview.token;
    } else {
      nextUrl = null;
      nextToken = null;
    }

    const changed =
      metadata.state !== nextState ||
      metadata.url !== nextUrl ||
      metadata.previewToken !== nextToken;

    if (!changed) return metadata;

    return this.saveMetadata({
      ...metadata,
      state: nextState,
      url: nextUrl,
      previewToken: nextToken,
      updatedAt: nowIso()
    });
  }
}
