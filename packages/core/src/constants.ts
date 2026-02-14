import path from "node:path";

export const DEFAULTS = {
  OPENCODE_PORT: 4096,
  OPENCODE_HOSTNAME: "0.0.0.0",
  OPENCODE_SERVER_USERNAME: "opencode",
  OPENCODE_SERVE_SESSION_ID: "opencode-serve",
  DEFAULT_PROVIDER_ID: "opencode",
  DAYTONA_API_URL: "https://app.daytona.io/api",
  DAYTONA_TARGET: "us",
  SANDBOX_LANGUAGE: "typescript",
  SANDBOX_CPU: 2,
  SANDBOX_MEMORY: 4,
  SANDBOX_DISK: 10,
  AUTO_STOP_MINUTES: 30,
  AUTO_ARCHIVE_MINUTES: 60 * 24 * 7,
  CREATE_TIMEOUT_MS: 120_000,
  HEALTH_TIMEOUT_MS: 60_000,
  HEALTH_POLL_INTERVAL_MS: 1_500,
  PASSWORD_LENGTH: 32,
  DEFAULT_DB_PATH: path.resolve(process.cwd(), "serverbox.db"),
  OPENCODE_BIN_PATH: "/home/daytona/.opencode/bin/opencode",
  OPENCODE_HOME_PATH: "/home/daytona/.local/share/opencode",
  OPENCODE_AUTH_PATH: "/home/daytona/.local/share/opencode/auth.json",
  OPENCODE_CONFIG_PATH: "/home/daytona/opencode.json"
} as const;
