import http, { type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from "node:http";
import https from "node:https";

import {
  ServerBoxError,
  createDefaultLogger,
  type CreateServerBoxOptions,
  type Logger,
  type ServerBoxMetadata
} from "@serverbox/core";
import { ServerBox } from "@serverbox/sdk";

import { ResumeCoordinator } from "./auto-resume.js";
import { checkApiKey } from "./auth.js";
import type { ProxyConfig, ProxyStartInfo } from "./types.js";

const DEFAULT_HOSTNAME = "127.0.0.1";
const DEFAULT_PORT = 7788;
const DEFAULT_RESUME_TIMEOUT_MS = 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);

function classifyRoute(pathname: string): "health" | "admin" | "instance" | "other" {
  if (pathname === "/healthz") return "health";
  if (pathname.startsWith("/admin/")) return "admin";
  if (pathname.startsWith("/i/")) return "instance";
  return "other";
}

function isConversationPath(pathname: string): boolean {
  return pathname.includes("/message") || pathname.endsWith("/prompt_async") || pathname.includes("/command");
}

function normalizePath(pathname: string): string {
  if (!pathname.startsWith("/")) return `/${pathname}`;
  return pathname;
}

function getRequestUrl(req: IncomingMessage): URL {
  const host = req.headers.host ?? "localhost";
  return new URL(req.url ?? "/", `http://${host}`);
}

function stripHeaders(headers: http.IncomingHttpHeaders): OutgoingHttpHeaders {
  const output: OutgoingHttpHeaders = {};

  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower)) continue;
    if (lower === "host") continue;
    if (lower === "authorization") continue;
    if (lower === "x-daytona-preview-token") continue;
    if (lower === "x-serverbox-admin-key") continue;
    if (lower === "x-serverbox-proxy-key") continue;
    output[key] = value;
  }

  return output;
}

async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return {} as T;
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new ServerBoxError("INVALID_CONFIG", "Invalid JSON request body.");
  }
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.setHeader("content-length", Buffer.byteLength(body));
  res.end(body);
}

function toErrorPayload(error: unknown): { error: string; code?: string } {
  if (error instanceof ServerBoxError) {
    return { error: error.message, code: error.code };
  }

  if (error instanceof Error) {
    return { error: error.message };
  }

  return { error: "Unknown error" };
}

function serializeInstance(metadata: ServerBoxMetadata, proxyBaseUrl: string): Record<string, unknown> {
  return {
    ...metadata,
    proxyUrl: `${proxyBaseUrl}/i/${metadata.id}`
  };
}

export class ServerBoxProxy {
  public readonly serverbox: ServerBox;

  private readonly config: Required<Pick<ProxyConfig, "hostname" | "port" | "autoResume" | "resumeTimeoutMs" | "requestTimeoutMs">> &
    {
      adminApiKey: string;
      proxyApiKey?: string;
      proxyAuthDisabled: boolean;
      requestLogging: boolean;
    };
  private readonly logger: Logger;
  private readonly resumeCoordinator: ResumeCoordinator;
  private readonly ownsServerBox: boolean;

  private server: http.Server | null = null;
  private startedInfo: ProxyStartInfo | null = null;

  constructor(config: ProxyConfig) {
    if (!config.adminApiKey) {
      throw new ServerBoxError("INVALID_CONFIG", "Proxy requires adminApiKey.");
    }

    const proxyAuthDisabled = config.proxyApiKey === null;
    const normalizedProxyApiKey =
      typeof config.proxyApiKey === "string" ? config.proxyApiKey.trim() : config.proxyApiKey;

    this.config = {
      hostname: config.hostname ?? DEFAULT_HOSTNAME,
      port: config.port ?? DEFAULT_PORT,
      adminApiKey: config.adminApiKey,
      proxyApiKey: proxyAuthDisabled
        ? undefined
        : (normalizedProxyApiKey || config.adminApiKey),
      proxyAuthDisabled,
      requestLogging: config.requestLogging ?? false,
      autoResume: config.autoResume ?? true,
      resumeTimeoutMs: config.resumeTimeoutMs ?? DEFAULT_RESUME_TIMEOUT_MS,
      requestTimeoutMs: config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    };

    this.logger = config.logger ?? createDefaultLogger((process.env.SERVERBOX_LOG_LEVEL as any) ?? "info");
    this.serverbox = config.serverbox ?? new ServerBox(config.serverboxConfig);
    this.ownsServerBox = !config.serverbox;
    this.resumeCoordinator = new ResumeCoordinator(
      this.serverbox,
      this.config.autoResume,
      this.config.resumeTimeoutMs,
      this.logger
    );
  }

  async start(): Promise<ProxyStartInfo> {
    if (this.server && this.startedInfo) return this.startedInfo;

    this.server = http.createServer((req, res) => {
      void this.handleRequest(req, res);
    });

    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(this.config.port, this.config.hostname, () => {
        resolve();
      });
    });

    const address = this.server.address();
    if (!address || typeof address === "string") {
      throw new ServerBoxError("INVALID_CONFIG", "Failed to determine proxy server address.");
    }

    this.startedInfo = {
      hostname: this.config.hostname,
      port: address.port,
      url: `http://${this.config.hostname}:${address.port}`
    };

    this.logger.info(`ServerBox proxy listening on ${this.startedInfo.url}`);
    return this.startedInfo;
  }

  async stop(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve, reject) => {
        this.server?.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }

    this.server = null;
    this.startedInfo = null;

    if (this.ownsServerBox) {
      await this.serverbox.close();
    }
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const startedAt = Date.now();
    const method = req.method ?? "GET";
    const initialUrl = getRequestUrl(req);
    const pathname = normalizePath(initialUrl.pathname);
    const routeType = classifyRoute(pathname);

    if (this.config.requestLogging) {
      this.logger.debug(`[http] -> ${method} ${pathname}${initialUrl.search}`);
    }

    res.once("finish", () => {
      if (!this.config.requestLogging) return;
      const duration = Date.now() - startedAt;
      this.logger.debug(
        `[http] <- ${method} ${pathname} status=${res.statusCode} duration=${duration}ms route=${routeType}`
      );
    });

    try {
      const url = initialUrl;

      if (pathname === "/healthz") {
        sendJson(res, 200, { ok: true });
        return;
      }

      if (pathname.startsWith("/admin/")) {
        await this.handleAdmin(req, res, url);
        return;
      }

      if (pathname.startsWith("/i/")) {
        await this.handleInstanceProxy(req, res, url);
        return;
      }

      sendJson(res, 404, {
        error: "Route not found"
      });
    } catch (error) {
      this.logger.error("[http] Request handling error", error);
      const payload = toErrorPayload(error);
      let status = 500;
      if (error instanceof ServerBoxError) {
        if (error.code === "INSTANCE_NOT_FOUND") status = 404;
        else if (error.code === "INSTANCE_NOT_RUNNING") status = 409;
        else if (error.code === "INVALID_CONFIG") status = 400;
      }
      sendJson(res, status, payload);
    }
  }

  private ensureAdminAuth(req: IncomingMessage, res: ServerResponse): boolean {
    if (checkApiKey(req, "x-serverbox-admin-key", this.config.adminApiKey)) {
      return true;
    }

    sendJson(res, 401, { error: "Unauthorized admin request." });
    return false;
  }

  private ensureProxyAuth(req: IncomingMessage, res: ServerResponse): boolean {
    if (this.config.proxyAuthDisabled) return true;
    if (!this.config.proxyApiKey) return true;

    if (checkApiKey(req, "x-serverbox-proxy-key", this.config.proxyApiKey)) {
      return true;
    }

    sendJson(res, 401, { error: "Unauthorized proxy request." });
    return false;
  }

  private async handleAdmin(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (!this.ensureAdminAuth(req, res)) return;

    const parts = url.pathname.split("/").filter(Boolean);
    const method = (req.method ?? "GET").toUpperCase();

    if (parts.length === 2 && parts[0] === "admin" && parts[1] === "instances" && method === "GET") {
      this.logger.debug("[admin] list instances request");
      const refresh = url.searchParams.get("refresh") === "true";
      const state = url.searchParams.get("state") ?? undefined;
      const instances = await this.serverbox.list({
        refresh,
        state: state as any
      });

      sendJson(res, 200, {
        instances,
        count: instances.length
      });
      return;
    }

    if (parts.length === 2 && parts[0] === "admin" && parts[1] === "instances" && method === "POST") {
      const payload = await readJsonBody<CreateServerBoxOptions>(req);
      this.logger.info(
        `[admin] creating instance providers=${Array.isArray(payload.auth)
          ? payload.auth.map((entry) => entry.provider).join(",")
          : payload.auth?.provider ?? "default"}`
      );
      const instance = await this.serverbox.create(payload);
      const metadata = instance.toJSON();
      this.logger.info(`[admin] created instance id=${metadata.id} state=${metadata.state}`);

      sendJson(res, 201, {
        instance: serializeInstance(metadata, this.requireStartedUrl())
      });
      return;
    }

    if (parts.length >= 3 && parts[0] === "admin" && parts[1] === "instances") {
      const id = parts[2] as string;

      if (parts.length === 3 && method === "GET") {
        this.logger.debug(`[admin] get instance id=${id}`);
        const instance = await this.serverbox.get(id);
        sendJson(res, 200, {
          instance: serializeInstance(instance.toJSON(), this.requireStartedUrl())
        });
        return;
      }

      if (parts.length === 4 && parts[3] === "resume" && method === "POST") {
        this.logger.info(`[admin] resume instance id=${id}`);
        const instance = await this.serverbox.get(id);
        await instance.resume({ timeout: this.config.resumeTimeoutMs });
        sendJson(res, 200, {
          instance: serializeInstance(instance.toJSON(), this.requireStartedUrl())
        });
        return;
      }

      if (parts.length === 4 && parts[3] === "stop" && method === "POST") {
        this.logger.info(`[admin] stop instance id=${id}`);
        const instance = await this.serverbox.get(id);
        await instance.stop();
        sendJson(res, 200, {
          instance: serializeInstance(instance.toJSON(), this.requireStartedUrl())
        });
        return;
      }

      if (parts.length === 4 && parts[3] === "archive" && method === "POST") {
        this.logger.info(`[admin] archive instance id=${id}`);
        const instance = await this.serverbox.get(id);
        await instance.archive();
        sendJson(res, 200, {
          instance: serializeInstance(instance.toJSON(), this.requireStartedUrl())
        });
        return;
      }

      if (parts.length === 3 && method === "DELETE") {
        this.logger.info(`[admin] destroy instance id=${id}`);
        await this.serverbox.destroy(id);
        sendJson(res, 200, { ok: true, id });
        return;
      }
    }

    sendJson(res, 404, { error: "Admin route not found" });
  }

  private async handleInstanceProxy(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (!this.ensureProxyAuth(req, res)) return;

    const parts = url.pathname.split("/").filter(Boolean);
    const instanceId = parts[1];
    if (!instanceId) {
      sendJson(res, 400, { error: "Missing instance id in route /i/:instanceId/*" });
      return;
    }

    const pathAfterId = parts.slice(2).join("/");
    const proxiedPath = `/${pathAfterId}`;

    if (this.config.requestLogging) {
      const conversation = isConversationPath(proxiedPath);
      this.logger.debug(
        `[proxy] instance=${instanceId} method=${req.method ?? "GET"} path=${proxiedPath}${url.search} conversation=${conversation}`
      );
    }

    const instance = await this.resumeCoordinator.ensureRunning(instanceId);
    const connection = instance.getConnectionInfo();
    const baseUrl = connection.baseUrl.endsWith("/") ? connection.baseUrl : `${connection.baseUrl}/`;
    const targetUrl = new URL(`${pathAfterId}${url.search}` || `/`, baseUrl);

    if (this.config.requestLogging) {
      this.logger.debug(`[proxy] upstream instance=${instanceId} target=${targetUrl.toString()}`);
    }

    await this.pipeProxyRequest(req, res, targetUrl, connection.headers);
  }

  private async pipeProxyRequest(
    req: IncomingMessage,
    res: ServerResponse,
    targetUrl: URL,
    connectionHeaders: Record<string, string>
  ): Promise<void> {
    const isHttps = targetUrl.protocol === "https:";
    const transport = isHttps ? https : http;

    const headers = stripHeaders(req.headers);
    headers["authorization"] = connectionHeaders.authorization;

    if (connectionHeaders["x-daytona-preview-token"]) {
      headers["x-daytona-preview-token"] = connectionHeaders["x-daytona-preview-token"];
    }

    headers["x-forwarded-host"] = req.headers.host ?? "";
    headers["x-forwarded-proto"] = "http";

    await new Promise<void>((resolve, reject) => {
      const proxyReq = transport.request(
        {
          protocol: targetUrl.protocol,
          hostname: targetUrl.hostname,
          port: targetUrl.port ? Number(targetUrl.port) : isHttps ? 443 : 80,
          method: req.method ?? "GET",
          path: `${targetUrl.pathname}${targetUrl.search}`,
          headers,
          timeout: this.config.requestTimeoutMs
        },
        (proxyRes) => {
          if (this.config.requestLogging) {
            this.logger.debug(
              `[proxy] upstream response status=${proxyRes.statusCode ?? 502} target=${targetUrl.pathname}`
            );
          }

          const responseHeaders: OutgoingHttpHeaders = { ...proxyRes.headers };
          for (const key of Object.keys(responseHeaders)) {
            if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
              delete responseHeaders[key];
            }
          }

          res.writeHead(proxyRes.statusCode ?? 502, responseHeaders);
          proxyRes.pipe(res);

          proxyRes.on("end", () => {
            resolve();
          });
        }
      );

      proxyReq.on("timeout", () => {
        this.logger.warn(`[proxy] upstream timeout target=${targetUrl.toString()}`);
        proxyReq.destroy(new Error("Upstream request timed out"));
      });

      proxyReq.on("error", (error) => {
        this.logger.warn(`[proxy] upstream error target=${targetUrl.toString()}: ${error.message}`);
        if (!res.headersSent) {
          sendJson(res, 502, {
            error: "Upstream proxy request failed",
            details: error.message
          });
          resolve();
          return;
        }
        reject(error);
      });

      req.pipe(proxyReq);
    });
  }

  private requireStartedUrl(): string {
    if (!this.startedInfo) {
      throw new ServerBoxError("INVALID_CONFIG", "Proxy server has not been started yet.");
    }
    return this.startedInfo.url;
  }
}
