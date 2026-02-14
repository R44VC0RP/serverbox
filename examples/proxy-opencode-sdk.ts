import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import chalk from "chalk";
import { createOpencodeClient } from "@opencode-ai/sdk";

type CliArgs = {
  help: boolean;
  keep: boolean;
  sessionId?: string;
  instanceId?: string;
};

type InstancePayload = {
  id: string;
  proxyUrl: string;
  state: string;
};

type AdminResponse = {
  instance: InstancePayload;
};

type AdminListResponse = {
  instances: Array<{
    id: string;
    state: string;
  }>;
  count: number;
};

type TextPart = {
  type?: string;
  text?: string;
};

const ui = {
  title: (message: string) => console.log(chalk.bold.cyan(message)),
  section: (message: string) => console.log(chalk.bold(message)),
  info: (message: string) => console.log(chalk.cyan(`i ${message}`)),
  success: (message: string) => console.log(chalk.green(`ok ${message}`)),
  warn: (message: string) => console.log(chalk.yellow(`! ${message}`)),
  error: (message: string) => console.error(chalk.red(`x ${message}`)),
  dim: (message: string) => console.log(chalk.gray(message)),
  assistant: (message: string) => console.log(chalk.magenta(`assistant> ${message}`)),
  prompt: () => chalk.blueBright("you> ")
};

function parseCliArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    help: false,
    keep: false
  };

  const readValue = (index: number, flag: string): string => {
    const value = argv[index + 1];
    if (!value || value.startsWith("-")) {
      throw new Error(`Missing value for ${flag}`);
    }
    return value;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];

    if (token === "-h" || token === "--help") {
      args.help = true;
      continue;
    }

    if (token === "--keep") {
      args.keep = true;
      continue;
    }

    if (token === "-s" || token === "--session") {
      args.sessionId = readValue(i, token);
      i += 1;
      continue;
    }

    if (token === "-i" || token === "--instance") {
      args.instanceId = readValue(i, token);
      i += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${token}`);
  }

  return args;
}

function printHelp(): void {
  ui.title("ServerBox Proxy + OpenCode SDK interactive CLI");
  console.log();
  ui.section("Usage:");
  ui.dim("  bun run example:proxy-cli [--keep] [-i <instance-id>] [-s <session-id>]");
  console.log();
  ui.section("Requirements:");
  ui.dim("  - ServerBox proxy running (default: http://127.0.0.1:7788)");
  ui.dim("  - SERVERBOX_ADMIN_API_KEY set (defaults to dev-admin-key)");
  ui.dim("  - OPENCODE_ZEN_API_KEY set (unless reusing an existing instance)");
  console.log();
  ui.section("Optional env:");
  ui.dim("  SERVERBOX_PROXY_URL=http://127.0.0.1:7788");
  ui.dim("  SERVERBOX_PROXY_API_KEY=<key>");
  ui.dim("  SERVERBOX_INSTANCE_ID=<id>");
  ui.dim("  SERVERBOX_KEEP_INSTANCE=true");
  ui.dim("  OPENCODE_PROVIDER=opencode");
  ui.dim("  OPENCODE_PROVIDER_API_KEY=<key>");
  console.log();
  ui.section("Reconnect options:");
  ui.dim("  -s, --session <session-id>   Reconnect to existing OpenCode session");
  ui.dim("  -i, --instance <instance-id> Restrict reconnect/search to one instance");
  console.log();
  ui.section("Notes:");
  ui.dim("  - /i/:instanceId/* requests trigger proxy auto-resume if sandbox is stopped.");
  ui.dim("  - --keep (or SERVERBOX_KEEP_INSTANCE=true) keeps new instances after exit.");
  console.log();
  ui.section("CLI commands:");
  ui.dim("  /help, /new, /attach <session-id>, /status, /stop, /resume, /id, /exit");
}

function parseBool(value: string | undefined, defaultValue: boolean): boolean {
  if (!value) return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return defaultValue;
}

async function adminRequest<T>(
  proxyBaseUrl: string,
  adminApiKey: string,
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const response = await fetch(`${proxyBaseUrl}${path}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      "x-serverbox-admin-key": adminApiKey
    }
  });

  if (!response.ok) {
    throw new Error(`Admin request failed (${init.method ?? "GET"} ${path}): ${response.status} ${await response.text()}`);
  }

  return (await response.json()) as T;
}

function extractText(parts: Array<TextPart> | undefined): string {
  return (
    parts
      ?.filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n")
      .trim() ?? ""
  );
}

async function createSession(client: ReturnType<typeof createOpencodeClient>): Promise<string> {
  const session = await client.session.create({
    body: {
      title: "ServerBox proxy interactive CLI"
    }
  });

  const sessionId = session.data?.id;
  if (!sessionId) {
    throw new Error("OpenCode SDK did not return a session id.");
  }
  return sessionId;
}

function createClient(proxyUrl: string, proxyApiKey: string): ReturnType<typeof createOpencodeClient> {
  return createOpencodeClient({
    baseUrl: proxyUrl,
    headers: {
      "x-serverbox-proxy-key": proxyApiKey
    },
    throwOnError: true
  });
}

function resolveClientProxyUrl(proxyBaseUrl: string, instanceProxyUrl: string): string {
  const base = new URL(proxyBaseUrl);
  const instance = new URL(instanceProxyUrl);
  const combined = new URL(instance.pathname, base);
  return combined.toString().replace(/\/$/, "");
}

function buildClientProxyUrl(proxyBaseUrl: string, instanceId: string): string {
  const base = new URL(proxyBaseUrl);
  const combined = new URL(`/i/${instanceId}`, base);
  return combined.toString().replace(/\/$/, "");
}

async function reconnectSession(
  proxyBaseUrl: string,
  adminApiKey: string,
  proxyApiKey: string,
  sessionId: string,
  preferredInstanceId?: string
): Promise<{ instance: InstancePayload; client: ReturnType<typeof createOpencodeClient> }> {
  if (preferredInstanceId) {
    const payload = await adminRequest<AdminResponse>(
      proxyBaseUrl,
      adminApiKey,
      `/admin/instances/${preferredInstanceId}`
    );
    const client = createClient(buildClientProxyUrl(proxyBaseUrl, preferredInstanceId), proxyApiKey);
    await client.session.get({
      path: { id: sessionId }
    });
    return { instance: payload.instance, client };
  }

  const list = await adminRequest<AdminListResponse>(proxyBaseUrl, adminApiKey, "/admin/instances");
  if (list.count === 0) {
    throw new Error("No instances found. Provide -i/--instance or create a new instance without -s.");
  }

  ui.info(`Searching ${list.count} instance(s) for session ${sessionId}...`);

  for (const candidate of list.instances) {
    const client = createClient(buildClientProxyUrl(proxyBaseUrl, candidate.id), proxyApiKey);
    try {
      ui.dim(`Checking instance ${candidate.id} (${candidate.state})`);
      await client.session.get({
        path: { id: sessionId }
      });

      const payload = await adminRequest<AdminResponse>(
        proxyBaseUrl,
        adminApiKey,
        `/admin/instances/${candidate.id}`
      );

      return {
        instance: payload.instance,
        client
      };
    } catch {
      // Keep trying other instances.
    }
  }

  throw new Error(
    `Session '${sessionId}' was not found in current instances. It may have been destroyed.`
  );
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    return;
  }

  const proxyBaseUrl = process.env.SERVERBOX_PROXY_URL ?? "http://127.0.0.1:7788";
  const adminApiKey = process.env.SERVERBOX_ADMIN_API_KEY ?? "dev-admin-key";
  const proxyApiKey = process.env.SERVERBOX_PROXY_API_KEY || adminApiKey;
  const keepInstance = parseBool(process.env.SERVERBOX_KEEP_INSTANCE, false) || args.keep;
  const requestedSessionId = args.sessionId;

  // Reuse existing instance if provided, otherwise create one.
  const existingInstanceId = args.instanceId ?? process.env.SERVERBOX_INSTANCE_ID;
  const provider = process.env.OPENCODE_PROVIDER ?? "opencode";
  const providerApiKey =
    process.env.OPENCODE_PROVIDER_API_KEY ??
    process.env.OPENCODE_ZEN_API_KEY;

  let instance: InstancePayload;
  let createdByScript = false;

  let client: ReturnType<typeof createOpencodeClient>;
  let sessionId: string;

  if (requestedSessionId) {
    ui.info(`Reconnecting to session ${requestedSessionId}...`);
    const reconnected = await reconnectSession(
      proxyBaseUrl,
      adminApiKey,
      proxyApiKey,
      requestedSessionId,
      existingInstanceId
    );

    instance = reconnected.instance;
    client = reconnected.client;
    sessionId = requestedSessionId;
  } else {
    if (existingInstanceId) {
      const payload = await adminRequest<AdminResponse>(
        proxyBaseUrl,
        adminApiKey,
        `/admin/instances/${existingInstanceId}`
      );
      instance = payload.instance;
    } else {
      if (!providerApiKey) {
        throw new Error(
          "Missing OPENCODE_ZEN_API_KEY (or OPENCODE_PROVIDER_API_KEY) to create a new instance."
        );
      }

      ui.info(`Creating new sandbox instance with provider '${provider}'...`);
      const payload = await adminRequest<AdminResponse>(proxyBaseUrl, adminApiKey, "/admin/instances", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          auth: {
            provider,
            apiKey: providerApiKey
          }
        })
      });

      instance = payload.instance;
      createdByScript = true;
      ui.success(`Created instance ${instance.id}`);
    }

    const clientBaseUrl = resolveClientProxyUrl(proxyBaseUrl, instance.proxyUrl);
    client = createClient(clientBaseUrl, proxyApiKey);
    sessionId = await createSession(client);
    ui.success(`Created session ${sessionId}`);
  }

  ui.success(`Connected to instance ${instance.id}`);
  ui.dim(`Proxy URL: ${instance.proxyUrl}`);
  ui.dim(`State: ${instance.state}`);
  ui.info("Type /help for commands. Send plain text to prompt OpenCode.");

  const clientBaseUrl = resolveClientProxyUrl(proxyBaseUrl, instance.proxyUrl);
  ui.dim(`Client URL: ${clientBaseUrl}`);
  ui.dim(`Session: ${sessionId}`);

  const rl = createInterface({ input, output });

  const cleanup = async (): Promise<void> => {
    rl.close();

    if (createdByScript && !keepInstance) {
      await fetch(`${proxyBaseUrl}/admin/instances/${instance.id}`, {
        method: "DELETE",
        headers: {
          "x-serverbox-admin-key": adminApiKey
        }
      }).catch(() => {
        return;
      });
      ui.warn(`Destroyed instance ${instance.id}`);
      return;
    }

    if (createdByScript && keepInstance) {
      ui.info(`Keeping instance ${instance.id} (SERVERBOX_KEEP_INSTANCE=true or --keep).`);
    }
  };

  const onSignal = (signal: string): void => {
    console.log();
    ui.warn(`Received ${signal}, shutting down...`);
    void cleanup().finally(() => {
      process.exit(0);
    });
  };

  process.once("SIGINT", () => onSignal("SIGINT"));
  process.once("SIGTERM", () => onSignal("SIGTERM"));

  try {
    while (true) {
      let raw: string;
      try {
        raw = await rl.question(ui.prompt());
      } catch (error) {
        if (error instanceof Error && error.message.toLowerCase().includes("readline was closed")) {
          break;
        }
        throw error;
      }

      const inputText = raw.trim();

      if (!inputText) continue;

      if (inputText === "/exit" || inputText === "/quit") {
        break;
      }

      if (inputText === "/help") {
        ui.section("Commands:");
        ui.dim("  /help          Show commands");
        ui.dim("  /new           Start a new OpenCode session");
        ui.dim("  /attach <id>   Attach to an existing OpenCode session id");
        ui.dim("  /status        Fetch instance state from admin API");
        ui.dim("  /stop          Stop sandbox instance");
        ui.dim("  /resume        Resume sandbox instance");
        ui.dim("  /id            Show instance and session IDs");
        ui.dim("  /exit          Exit CLI");
        continue;
      }

      if (inputText.startsWith("/attach ")) {
        const candidate = inputText.slice("/attach ".length).trim();
        if (!candidate) {
          ui.warn("usage: /attach <session-id>");
          continue;
        }
        ui.info(`Attaching to session ${candidate}...`);
        await client.session.get({
          path: { id: candidate }
        });
        sessionId = candidate;
        ui.success(`Attached to session ${sessionId}`);
        continue;
      }

      if (inputText === "/new") {
        ui.info("Creating new session...");
        sessionId = await createSession(client);
        ui.success(`Session: ${sessionId}`);
        continue;
      }

      if (inputText === "/status") {
        const payload = await adminRequest<AdminResponse>(
          proxyBaseUrl,
          adminApiKey,
          `/admin/instances/${instance.id}`
        );
        instance = payload.instance;
        ui.info(`State: ${instance.state}`);
        continue;
      }

      if (inputText === "/stop") {
        const payload = await adminRequest<AdminResponse>(
          proxyBaseUrl,
          adminApiKey,
          `/admin/instances/${instance.id}/stop`,
          { method: "POST" }
        );
        instance = payload.instance;
        ui.warn("Instance stopped. Next prompt will auto-resume through proxy.");
        continue;
      }

      if (inputText === "/resume") {
        const payload = await adminRequest<AdminResponse>(
          proxyBaseUrl,
          adminApiKey,
          `/admin/instances/${instance.id}/resume`,
          { method: "POST" }
        );
        instance = payload.instance;
        ui.success("Instance resumed.");
        continue;
      }

      if (inputText === "/id") {
        ui.info(`Instance: ${instance.id}`);
        ui.info(`Session: ${sessionId}`);
        continue;
      }

      ui.dim(`Sending prompt to session ${sessionId}...`);
      const promptResponse = await client.session.prompt({
        path: { id: sessionId },
        body: {
          parts: [{ type: "text", text: inputText }]
        }
      });

      const text = extractText((promptResponse.data as { parts?: Array<TextPart> })?.parts);

      if (text) {
        ui.assistant(text);
      } else {
        ui.assistant("[no text output]");
      }
    }
  } finally {
    await cleanup();
  }
}

main().catch((error) => {
  ui.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
