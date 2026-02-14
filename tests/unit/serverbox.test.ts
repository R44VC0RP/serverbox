import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { ServerBox } from "../../packages/sdk/src/serverbox.js";

class FakeSandbox {
  public readonly id: string;
  public readonly instance: { state: string };
  public readonly process: {
    executeCommand: ReturnType<typeof vi.fn>;
    createSession: ReturnType<typeof vi.fn>;
    deleteSession: ReturnType<typeof vi.fn>;
    executeSessionCommand: ReturnType<typeof vi.fn>;
  };
  public readonly fs: {
    uploadFile: ReturnType<typeof vi.fn>;
    downloadFile: ReturnType<typeof vi.fn>;
  };

  constructor(id: string) {
    this.id = id;
    this.instance = { state: "started" };
    this.process = {
      executeCommand: vi.fn(async () => ({ exitCode: 0, artifacts: { stdout: "ok", stderr: "" } })),
      createSession: vi.fn(async () => ({})),
      deleteSession: vi.fn(async () => ({})),
      executeSessionCommand: vi.fn(async () => ({}))
    };
    this.fs = {
      uploadFile: vi.fn(async () => ({})),
      downloadFile: vi.fn(async () => Buffer.from("downloaded-content", "utf8"))
    };
  }

  async getPreviewLink(port: number): Promise<{ url: string; token: string }> {
    return {
      url: `https://preview.test/${this.id}/${port}`,
      token: "preview-token"
    };
  }

  async start(): Promise<void> {
    this.instance.state = "started";
  }

  async stop(): Promise<void> {
    this.instance.state = "stopped";
  }

  async archive(): Promise<void> {
    this.instance.state = "archived";
  }

  async delete(): Promise<void> {
    this.instance.state = "deleted";
  }
}

class FakeDaytona {
  public readonly sandboxes = new Map<string, FakeSandbox>();

  async create(input: Record<string, unknown>): Promise<FakeSandbox> {
    const id = String(input.id ?? `sandbox-${this.sandboxes.size + 1}`);
    const sandbox = new FakeSandbox(id);
    this.sandboxes.set(id, sandbox);
    return sandbox;
  }

  async findOne(id: string): Promise<FakeSandbox> {
    const sandbox = this.sandboxes.get(id);
    if (!sandbox) throw new Error("Sandbox not found");
    return sandbox;
  }

  async remove(sandbox: FakeSandbox): Promise<void> {
    this.sandboxes.delete(sandbox.id);
  }

  async list(): Promise<FakeSandbox[]> {
    return [...this.sandboxes.values()];
  }
}

describe("ServerBox", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ healthy: true, version: "test-version" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      )
    );
  });

  it("creates, stops, resumes, runs commands, and destroys an instance", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "serverbox-unit-"));
    const dbPath = path.join(tempDir, "metadata.db");
    const daytona = new FakeDaytona();

    const sb = new ServerBox({
      dbPath,
      daytonaClient: daytona
    });

    const instance = await sb.create({
      auth: {
        provider: "opencode",
        apiKey: "zen-key"
      },
      opencode: {
        model: "opencode/gpt-5.1-codex"
      }
    });

    expect(instance.state).toBe("running");
    expect(instance.url).toContain("https://preview.test/");

    const connection = instance.getConnectionInfo();
    expect(connection.headers.authorization).toMatch(/^Basic /);
    expect(connection.headers["x-daytona-preview-token"]).toBe("preview-token");

    const health = await instance.health();
    expect(health.healthy).toBe(true);

    const execResult = await instance.exec("echo hello");
    expect(execResult.exitCode).toBe(0);

    await instance.uploadFile("/tmp/file.txt", "hello");
    const downloaded = await instance.downloadFile("/tmp/file.txt");
    expect(downloaded.toString("utf8")).toBe("downloaded-content");

    await instance.stop();
    expect(instance.state).toBe("stopped");

    await expect(instance.exec("echo blocked")).rejects.toMatchObject({
      code: "INSTANCE_NOT_RUNNING"
    });

    await instance.resume();
    expect(instance.state).toBe("running");

    await instance.archive();
    expect(instance.state).toBe("archived");

    await instance.resume();
    expect(instance.state).toBe("running");

    await instance.destroy();
    const listed = await sb.list();
    expect(listed).toHaveLength(0);

    await sb.close();
  });
});
