export type ServerBoxState =
  | "provisioning"
  | "bootstrapping"
  | "running"
  | "stopped"
  | "archived"
  | "error"
  | "destroyed";

export interface ProviderAuth {
  provider: string;
  apiKey?: string;
  env?: Record<string, string>;
}

export interface OpenCodeProviderConfig {
  npm?: string;
  name?: string;
  options?: Record<string, unknown>;
  models?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface OpenCodeConfig {
  model?: string;
  small_model?: string;
  provider?: Record<string, OpenCodeProviderConfig>;
  [key: string]: unknown;
}

export interface ResourceConfig {
  cpu?: number;
  memory?: number;
  disk?: number;
}

export interface LifecycleConfig {
  autoStopMinutes?: number;
  autoArchiveMinutes?: number;
  autoDeleteMinutes?: number;
}

export interface CreateServerBoxOptions {
  id?: string;
  auth?: ProviderAuth | ProviderAuth[];
  opencode?: OpenCodeConfig;
  resources?: ResourceConfig;
  lifecycle?: LifecycleConfig;
  labels?: Record<string, string>;
  timeout?: number;
}

export interface ListInstancesOptions {
  state?: ServerBoxState;
  labels?: Record<string, string>;
  refresh?: boolean;
}

export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

export interface ServerBoxConfig {
  daytonaApiKey?: string;
  daytonaApiUrl?: string;
  daytonaTarget?: string;
  dbPath?: string;
  store?: MetadataStore;
  logger?: Logger;
  daytonaClient?: unknown;
}

export interface ServerBoxMetadata {
  id: string;
  sandboxId: string;
  state: ServerBoxState;
  url: string | null;
  previewToken: string | null;
  username: string;
  password: string;
  providers: string[];
  labels: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

export interface ConnectionInfo {
  baseUrl: string;
  username: string;
  password: string;
  previewToken: string | null;
  headers: Record<string, string>;
}

export interface HealthStatus {
  healthy: boolean;
  version: string;
  [key: string]: unknown;
}

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeout?: number;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface MetadataStore {
  get(id: string): Promise<ServerBoxMetadata | null>;
  set(metadata: ServerBoxMetadata): Promise<void>;
  list(): Promise<ServerBoxMetadata[]>;
  delete(id: string): Promise<void>;
  close?(): Promise<void>;
}
