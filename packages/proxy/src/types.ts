import type { Logger, ServerBoxConfig } from "@serverbox/core";
import type { ServerBox } from "@serverbox/sdk";

export interface ProxyConfig {
  hostname?: string;
  port?: number;
  adminApiKey: string;
  // If omitted, proxy auth reuses adminApiKey.
  // Set to null to disable proxy auth checks for /i/:instanceId/* routes.
  proxyApiKey?: string | null;
  requestLogging?: boolean;
  autoResume?: boolean;
  resumeTimeoutMs?: number;
  requestTimeoutMs?: number;
  serverboxConfig?: ServerBoxConfig;
  serverbox?: ServerBox;
  logger?: Logger;
}

export interface ProxyStartInfo {
  hostname: string;
  port: number;
  url: string;
}
