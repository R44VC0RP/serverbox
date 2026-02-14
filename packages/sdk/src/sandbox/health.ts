import { DEFAULTS, ServerBoxError, type HealthStatus } from "@serverbox/core";

export interface HealthCheckInput {
  baseUrl: string;
  username: string;
  password: string;
  previewToken?: string | null;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
}

function toBasicAuth(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

export function buildConnectionHeaders(input: HealthCheckInput): Record<string, string> {
  const headers: Record<string, string> = {
    authorization: toBasicAuth(input.username, input.password)
  };

  if (input.previewToken) {
    headers["x-daytona-preview-token"] = input.previewToken;
  }

  return headers;
}

export async function checkOpenCodeHealth(input: HealthCheckInput): Promise<HealthStatus> {
  const healthUrl = `${normalizeBaseUrl(input.baseUrl)}/global/health`;
  const response = await fetch(healthUrl, {
    method: "GET",
    headers: buildConnectionHeaders(input)
  });

  if (!response.ok) {
    throw new ServerBoxError(
      "HEALTH_CHECK_FAILED",
      `OpenCode health check failed with HTTP ${response.status}.`
    );
  }

  const json = (await response.json()) as HealthStatus;
  if (!json.healthy) {
    throw new ServerBoxError("HEALTH_CHECK_FAILED", "OpenCode server reported unhealthy status.");
  }

  return json;
}

export async function waitForOpenCodeHealth(
  input: HealthCheckInput,
  timeoutMs: number = DEFAULTS.HEALTH_TIMEOUT_MS,
  pollIntervalMs: number = DEFAULTS.HEALTH_POLL_INTERVAL_MS
): Promise<HealthStatus> {
  const startedAt = Date.now();
  let lastError: unknown;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      return await checkOpenCodeHealth(input);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => {
        setTimeout(resolve, pollIntervalMs);
      });
    }
  }

  throw ServerBoxError.wrap("HEALTH_CHECK_FAILED", lastError, "Timed out waiting for OpenCode health check.");
}
