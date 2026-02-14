import http, { type IncomingMessage, type ServerResponse } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import type { ServerBoxMetadata, ServerBoxState } from "../../packages/core/src/types.js";
import { ServerBoxProxy } from "../../packages/proxy/src/server.js";

async function startHttpServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(handler);

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to get server address");
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  };
}

class FakeInstance {
  public state: ServerBoxState;
  public resumeCalls = 0;

  constructor(
    private readonly metadata: ServerBoxMetadata,
    state: ServerBoxState,
    private readonly connectionHeaders: Record<string, string>
  ) {
    this.state = state;
  }

  get id(): string {
    return this.metadata.id;
  }

  getConnectionInfo(): {
    baseUrl: string;
    username: string;
    password: string;
    previewToken: string | null;
    headers: Record<string, string>;
  } {
    if (this.state !== "running") {
      throw new Error("instance not running");
    }

    return {
      baseUrl: this.metadata.url as string,
      username: this.metadata.username,
      password: this.metadata.password,
      previewToken: this.metadata.previewToken,
      headers: this.connectionHeaders
    };
  }

  async resume(): Promise<this> {
    this.resumeCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 30));
    this.state = "running";
    return this;
  }

  async stop(): Promise<this> {
    this.state = "stopped";
    return this;
  }

  async archive(): Promise<this> {
    this.state = "archived";
    return this;
  }

  toJSON(): ServerBoxMetadata {
    return {
      ...this.metadata,
      state: this.state,
      url: this.state === "running" ? this.metadata.url : null,
      previewToken: this.state === "running" ? this.metadata.previewToken : null
    };
  }
}

class FakeServerBox {
  private readonly instances = new Map<string, FakeInstance>();
  private nextId = 1;

  add(instance: FakeInstance): void {
    this.instances.set(instance.id, instance);
  }

  async get(id: string): Promise<FakeInstance> {
    const instance = this.instances.get(id);
    if (!instance) {
      throw new Error(`instance ${id} not found`);
    }
    return instance;
  }

  async list(): Promise<ServerBoxMetadata[]> {
    return [...this.instances.values()].map((instance) => instance.toJSON());
  }

  async create(): Promise<FakeInstance> {
    const id = `instance-${this.nextId}`;
    this.nextId += 1;

    const metadata: ServerBoxMetadata = {
      id,
      sandboxId: id,
      state: "running",
      url: "https://example.invalid",
      previewToken: "preview-token",
      username: "opencode",
      password: "password",
      providers: ["opencode"],
      labels: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    const instance = new FakeInstance(metadata, "running", {
      authorization: "Basic test",
      "x-daytona-preview-token": "preview-token"
    });

    this.instances.set(id, instance);
    return instance;
  }

  async destroy(id: string): Promise<void> {
    this.instances.delete(id);
  }

  async close(): Promise<void> {
    return;
  }
}

const openProxies: ServerBoxProxy[] = [];

afterEach(async () => {
  while (openProxies.length > 0) {
    const proxy = openProxies.pop();
    if (proxy) {
      await proxy.stop();
    }
  }
});

describe("ServerBoxProxy", () => {
  it("forwards instance requests and injects OpenCode auth headers", async () => {
    let seenPath = "";
    let seenAuth = "";
    let seenPreviewToken = "";

    const upstream = await startHttpServer((req, res) => {
      seenPath = req.url ?? "";
      seenAuth = String(req.headers.authorization ?? "");
      seenPreviewToken = String(req.headers["x-daytona-preview-token"] ?? "");
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true }));
    });

    try {
      const metadata: ServerBoxMetadata = {
        id: "instance-a",
        sandboxId: "sandbox-a",
        state: "running",
        url: upstream.url,
        previewToken: "preview-token",
        username: "opencode",
        password: "password",
        providers: ["opencode"],
        labels: {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      const fakeServerBox = new FakeServerBox();
      fakeServerBox.add(
        new FakeInstance(metadata, "running", {
          authorization: "Basic injected-auth",
          "x-daytona-preview-token": "preview-token"
        })
      );

      const proxy = new ServerBoxProxy({
        serverbox: fakeServerBox as any,
        adminApiKey: "admin-key",
        proxyApiKey: "proxy-key"
      });
      openProxies.push(proxy);

      const started = await proxy.start();
      const response = await fetch(`${started.url}/i/instance-a/session?x=1`, {
        method: "GET",
        headers: {
          "x-serverbox-proxy-key": "proxy-key"
        }
      });

      expect(response.status).toBe(200);
      expect(seenPath).toBe("/session?x=1");
      expect(seenAuth).toBe("Basic injected-auth");
      expect(seenPreviewToken).toBe("preview-token");
    } finally {
      await upstream.close();
    }
  });

  it("auto-resumes a stopped instance once for concurrent requests", async () => {
    const upstream = await startHttpServer((_, res) => {
      res.statusCode = 200;
      res.end("ok");
    });

    try {
      const metadata: ServerBoxMetadata = {
        id: "instance-b",
        sandboxId: "sandbox-b",
        state: "stopped",
        url: upstream.url,
        previewToken: "preview-token",
        username: "opencode",
        password: "password",
        providers: ["opencode"],
        labels: {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      const instance = new FakeInstance(metadata, "stopped", {
        authorization: "Basic injected-auth",
        "x-daytona-preview-token": "preview-token"
      });

      const fakeServerBox = new FakeServerBox();
      fakeServerBox.add(instance);

      const proxy = new ServerBoxProxy({
        serverbox: fakeServerBox as any,
        adminApiKey: "admin-key",
        proxyApiKey: null
      });
      openProxies.push(proxy);

      const started = await proxy.start();

      const [a, b] = await Promise.all([
        fetch(`${started.url}/i/instance-b/global/health`),
        fetch(`${started.url}/i/instance-b/global/health`)
      ]);

      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      expect(instance.resumeCalls).toBe(1);
    } finally {
      await upstream.close();
    }
  });

  it("enforces admin auth and serves admin instance endpoints", async () => {
    const fakeServerBox = new FakeServerBox();
    const proxy = new ServerBoxProxy({
      serverbox: fakeServerBox as any,
      adminApiKey: "admin-key"
    });
    openProxies.push(proxy);

    const started = await proxy.start();

    const unauthorized = await fetch(`${started.url}/admin/instances`);
    expect(unauthorized.status).toBe(401);

    const created = await fetch(`${started.url}/admin/instances`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-serverbox-admin-key": "admin-key"
      },
      body: JSON.stringify({
        auth: { provider: "opencode", apiKey: "zen-key" }
      })
    });

    expect(created.status).toBe(201);
    const createdPayload = (await created.json()) as { instance: { id: string; proxyUrl: string } };
    expect(createdPayload.instance.id).toBe("instance-1");
    expect(createdPayload.instance.proxyUrl).toContain("/i/instance-1");

    const listed = await fetch(`${started.url}/admin/instances`, {
      headers: {
        "x-serverbox-admin-key": "admin-key"
      }
    });
    expect(listed.status).toBe(200);

    const listedPayload = (await listed.json()) as { count: number };
    expect(listedPayload.count).toBe(1);
  });
});
