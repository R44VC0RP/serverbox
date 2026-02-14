import {
  DEFAULTS,
  ServerBoxError,
  type Logger,
  type OpenCodeConfig
} from "@serverbox/core";

import {
  executeSandboxCommand,
  restartSessionCommand,
  uploadFileToSandbox
} from "./runtime.js";

function quoteShell(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function envPrefix(env: Record<string, string>): string {
  const chunks: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    chunks.push(`${key}=${quoteShell(value)}`);
  }
  return chunks.join(" ");
}

function serializeJson(content: Record<string, unknown>): string {
  return `${JSON.stringify(content, null, 2)}\n`;
}

export interface BootstrapOptions {
  username: string;
  password: string;
  providerEnv: Record<string, string>;
  authRecord: Record<string, string> | null;
  opencodeConfig: OpenCodeConfig | null;
  installOpenCode: boolean;
  logger: Logger;
}

export async function bootstrapOpenCodeServer(
  sandbox: any,
  options: BootstrapOptions
): Promise<void> {
  const { installOpenCode, authRecord, opencodeConfig, logger } = options;

  logger.debug(`Preparing OpenCode home at ${DEFAULTS.OPENCODE_HOME_PATH}`);

  await executeSandboxCommand(sandbox, `mkdir -p ${DEFAULTS.OPENCODE_HOME_PATH}`);

  if (installOpenCode) {
    logger.info("Installing opencode inside sandbox...");
    const installResult = await executeSandboxCommand(
      sandbox,
      "curl -fsSL https://opencode.ai/install | bash -s -- --no-modify-path"
    );
    if (installResult.exitCode !== 0) {
      throw new ServerBoxError(
        "BOOTSTRAP_FAILED",
        `Failed to install opencode: ${installResult.stderr || installResult.stdout}`
      );
    }

    logger.info("OpenCode installation completed.");
  }

  if (authRecord) {
    logger.debug(`Writing OpenCode auth record (${Object.keys(authRecord).length} provider entries)`);
    await uploadFileToSandbox(sandbox, DEFAULTS.OPENCODE_AUTH_PATH, serializeJson(authRecord));
  }

  if (opencodeConfig) {
    logger.debug("Writing opencode.json config");
    await uploadFileToSandbox(
      sandbox,
      DEFAULTS.OPENCODE_CONFIG_PATH,
      serializeJson(opencodeConfig as Record<string, unknown>)
    );
  }

  const commandEnv = {
    OPENCODE_SERVER_PASSWORD: options.password,
    OPENCODE_SERVER_USERNAME: options.username,
    ...options.providerEnv
  };

  const serveCommand = `${envPrefix(commandEnv)} ${DEFAULTS.OPENCODE_BIN_PATH} serve --port ${DEFAULTS.OPENCODE_PORT} --hostname ${DEFAULTS.OPENCODE_HOSTNAME}`;

  logger.info(`Starting OpenCode server on ${DEFAULTS.OPENCODE_HOSTNAME}:${DEFAULTS.OPENCODE_PORT}`);

  await restartSessionCommand(sandbox, DEFAULTS.OPENCODE_SERVE_SESSION_ID, serveCommand);

  logger.debug("OpenCode serve command launched");
}
