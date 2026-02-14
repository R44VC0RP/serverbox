import { Daytona } from "@daytonaio/sdk";
import {
  DEFAULTS,
  ServerBoxError,
  type ServerBoxConfig,
  type ServerBoxState
} from "@serverbox/core";

export interface PreviewLink {
  url: string;
  token: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function notFound(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.message.toLowerCase().includes("not found");
}

export class DaytonaAdapter {
  private readonly client: any;

  constructor(config: ServerBoxConfig) {
    if (config.daytonaClient) {
      this.client = config.daytonaClient;
      return;
    }

    const apiKey = config.daytonaApiKey ?? process.env.DAYTONA_API_KEY;
    if (!apiKey) {
      throw new ServerBoxError(
        "MISSING_DAYTONA_API_KEY",
        "Missing Daytona API key. Set daytonaApiKey in ServerBox config or DAYTONA_API_KEY env var."
      );
    }

    this.client = new Daytona({
      apiKey,
      apiUrl: config.daytonaApiUrl ?? process.env.DAYTONA_API_URL ?? DEFAULTS.DAYTONA_API_URL,
      serverUrl: config.daytonaApiUrl ?? process.env.DAYTONA_API_URL ?? DEFAULTS.DAYTONA_API_URL,
      target: config.daytonaTarget ?? process.env.DAYTONA_TARGET ?? DEFAULTS.DAYTONA_TARGET
    } as any);
  }

  async createSandbox(params: Record<string, unknown>): Promise<any> {
    try {
      return await this.client.create(params);
    } catch (error) {
      throw ServerBoxError.wrap("DAYTONA_API_ERROR", error, "Failed to create Daytona sandbox");
    }
  }

  async findSandbox(id: string): Promise<any> {
    try {
      if (typeof this.client.findOne === "function") {
        return await this.client.findOne(id);
      }

      if (typeof this.client.get === "function") {
        return await this.client.get(id);
      }

      const sandboxes = await this.listSandboxes();
      const sandbox = sandboxes.find((item) => this.getSandboxId(item) === id);
      if (!sandbox) {
        throw new ServerBoxError("SANDBOX_NOT_FOUND", `Sandbox ${id} was not found.`);
      }
      return sandbox;
    } catch (error) {
      if (notFound(error)) {
        throw new ServerBoxError("SANDBOX_NOT_FOUND", `Sandbox ${id} was not found.`);
      }
      throw ServerBoxError.wrap("DAYTONA_API_ERROR", error, `Failed to fetch sandbox ${id}`);
    }
  }

  async listSandboxes(): Promise<any[]> {
    try {
      if (typeof this.client.list !== "function") return [];
      const response = await this.client.list();

      if (Array.isArray(response)) return response;
      if (isRecord(response) && Array.isArray(response.items)) return response.items as any[];
      return [];
    } catch (error) {
      throw ServerBoxError.wrap("DAYTONA_API_ERROR", error, "Failed to list sandboxes");
    }
  }

  async removeSandbox(sandbox: any): Promise<void> {
    try {
      if (typeof sandbox?.delete === "function") {
        await sandbox.delete();
        return;
      }

      if (typeof this.client.remove === "function") {
        await this.client.remove(sandbox);
        return;
      }

      if (typeof this.client.delete === "function") {
        await this.client.delete(sandbox);
        return;
      }

      throw new ServerBoxError("UNSUPPORTED_OPERATION", "No sandbox delete operation is available.");
    } catch (error) {
      throw ServerBoxError.wrap("DAYTONA_API_ERROR", error, "Failed to remove sandbox");
    }
  }

  async getPreviewLink(sandbox: any, port: number): Promise<PreviewLink> {
    if (typeof sandbox?.getPreviewLink !== "function" && typeof sandbox?.getPreviewUrl !== "function") {
      throw new ServerBoxError(
        "UNSUPPORTED_OPERATION",
        "Sandbox preview method not available. Expected getPreviewLink() or getPreviewUrl()."
      );
    }

    const method = sandbox.getPreviewLink ?? sandbox.getPreviewUrl;
    const output = await method.call(sandbox, port);

    if (typeof output === "string") {
      return { url: output, token: null };
    }

    if (isRecord(output) && typeof output.url === "string") {
      return {
        url: output.url,
        token: typeof output.token === "string" ? output.token : null
      };
    }

    throw new ServerBoxError("DAYTONA_API_ERROR", "Invalid preview URL response from Daytona SDK.");
  }

  getSandboxId(sandbox: any): string {
    const id = sandbox?.id ?? sandbox?.instance?.id;
    if (typeof id !== "string" || !id) {
      throw new ServerBoxError("DAYTONA_API_ERROR", "Sandbox id is missing from Daytona response.");
    }
    return id;
  }

  getSandboxState(sandbox: any): ServerBoxState {
    const stateRaw =
      sandbox?.instance?.state ?? sandbox?.state ?? sandbox?.status ?? "unknown";
    const normalized = String(stateRaw).toLowerCase();

    if (normalized === "running" || normalized === "started") return "running";
    if (normalized === "stopped") return "stopped";
    if (normalized === "archived") return "archived";
    if (normalized === "destroyed" || normalized === "deleted") return "destroyed";
    if (normalized === "provisioning" || normalized === "creating") return "provisioning";
    return "error";
  }
}
