import { ServerBoxError, type ConnectionInfo, type ExecOptions, type ExecResult, type HealthStatus, type ServerBoxMetadata, type ServerBoxState } from "@serverbox/core";

import type { ServerBox } from "./serverbox.js";

export class ServerBoxInstance {
  constructor(private readonly manager: ServerBox, private metadata: ServerBoxMetadata) {}

  get id(): string {
    return this.metadata.id;
  }

  get sandboxId(): string {
    return this.metadata.sandboxId;
  }

  get state(): ServerBoxState {
    return this.metadata.state;
  }

  get url(): string | null {
    return this.metadata.url;
  }

  get credentials(): { username: string; password: string } {
    return {
      username: this.metadata.username,
      password: this.metadata.password
    };
  }

  get providers(): string[] {
    return [...this.metadata.providers];
  }

  getConnectionInfo(): ConnectionInfo {
    if (!this.metadata.url) {
      throw new ServerBoxError(
        "INSTANCE_NOT_RUNNING",
        `Instance ${this.metadata.id} is not running. Resume it before requesting connection info.`
      );
    }

    return this.manager.buildConnectionInfo(this.metadata);
  }

  async refresh(): Promise<this> {
    this.metadata = await this.manager.refreshInstance(this.id);
    return this;
  }

  async stop(): Promise<this> {
    this.metadata = await this.manager.stopInstance(this.id);
    return this;
  }

  async resume(options?: { timeout?: number }): Promise<this> {
    this.metadata = await this.manager.resumeInstance(this.id, options?.timeout);
    return this;
  }

  async archive(): Promise<this> {
    this.metadata = await this.manager.archiveInstance(this.id);
    return this;
  }

  async destroy(): Promise<void> {
    await this.manager.destroy(this.id);
    this.metadata = {
      ...this.metadata,
      state: "destroyed",
      url: null,
      previewToken: null,
      updatedAt: new Date().toISOString()
    };
  }

  async health(): Promise<HealthStatus> {
    return this.manager.healthInstance(this.id);
  }

  async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
    return this.manager.execInstance(this.id, command, options);
  }

  async uploadFile(remotePath: string, content: Buffer | string): Promise<void> {
    return this.manager.uploadFileInstance(this.id, remotePath, content);
  }

  async downloadFile(remotePath: string): Promise<Buffer> {
    return this.manager.downloadFileInstance(this.id, remotePath);
  }

  toJSON(): ServerBoxMetadata {
    return { ...this.metadata, providers: [...this.metadata.providers], labels: { ...this.metadata.labels } };
  }
}
