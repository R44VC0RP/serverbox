import { createDefaultLogger, ServerBoxError } from "@serverbox/core";

import { ServerBoxProxy } from "./server.js";

function parseOptionalInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function parseOptionalBoolean(value: string | undefined, fallback: boolean): boolean {
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

async function main(): Promise<void> {
  const logger = createDefaultLogger((process.env.SERVERBOX_LOG_LEVEL as any) ?? "info");

  const adminApiKey = process.env.SERVERBOX_ADMIN_API_KEY;
  if (!adminApiKey) {
    throw new ServerBoxError(
      "INVALID_CONFIG",
      "Missing SERVERBOX_ADMIN_API_KEY. Set it in your environment or .env file."
    );
  }

  const hostname = process.env.SERVERBOX_PROXY_HOST ?? "0.0.0.0";
  const port = parseOptionalInt(process.env.SERVERBOX_PROXY_PORT, 7788);
  const autoResume = parseOptionalBoolean(process.env.SERVERBOX_PROXY_AUTO_RESUME, true);
  const requestLogging = parseOptionalBoolean(process.env.SERVERBOX_PROXY_REQUEST_LOGS, true);
  const resumeTimeoutMs = parseOptionalInt(process.env.SERVERBOX_PROXY_RESUME_TIMEOUT_MS, 60_000);
  const requestTimeoutMs = parseOptionalInt(process.env.SERVERBOX_PROXY_REQUEST_TIMEOUT_MS, 60_000);

  logger.info(
    `Proxy config host=${hostname} port=${port} autoResume=${autoResume} requestLogs=${requestLogging} logLevel=${process.env.SERVERBOX_LOG_LEVEL ?? "info"}`
  );

  const proxy = new ServerBoxProxy({
    hostname,
    port,
    adminApiKey,
    proxyApiKey: process.env.SERVERBOX_PROXY_API_KEY,
    requestLogging,
    autoResume,
    resumeTimeoutMs,
    requestTimeoutMs,
    serverboxConfig: {
      daytonaApiKey: process.env.DAYTONA_API_KEY,
      daytonaApiUrl: process.env.DAYTONA_API_URL,
      daytonaTarget: process.env.DAYTONA_TARGET,
      dbPath: process.env.SERVERBOX_DB_PATH
    },
    logger
  });

  const started = await proxy.start();
  logger.info(`Proxy started on ${started.url}`);

  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`Received ${signal}. Shutting down proxy...`);
    try {
      await proxy.stop();
      logger.info("Proxy stopped cleanly.");
      process.exit(0);
    } catch (error) {
      logger.error("Failed to stop proxy cleanly", error);
      process.exit(1);
    }
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
