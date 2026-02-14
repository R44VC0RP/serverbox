# ServerBox

On-demand, sandboxed [OpenCode](https://opencode.ai) server instances powered by [Daytona](https://daytona.io).

ServerBox manages infrastructure and lifecycle only. You get back a URL and credentials, then use [`@opencode-ai/sdk`](https://www.npmjs.com/package/@opencode-ai/sdk) directly against it.

## Demo

https://x.com/ryanvogel/status/2022495102615326850

## Install

```bash
npm install @serverbox/sdk
# or
bun add @serverbox/sdk
```

| Package | Description |
|---|---|
| [`@serverbox/core`](https://www.npmjs.com/package/@serverbox/core) | Shared types, errors, constants, SQLite metadata store |
| [`@serverbox/sdk`](https://www.npmjs.com/package/@serverbox/sdk) | ServerBox manager and instance lifecycle operations |
| [`@serverbox/proxy`](https://www.npmjs.com/package/@serverbox/proxy) | Stable-URL reverse proxy with admin API and auto-resume |

## How It Works

```
ServerBox.create()
  -> spins up a Daytona sandbox (~90ms)
  -> installs OpenCode
  -> starts `opencode serve` on port 4096
  -> returns a public URL + credentials

You use @opencode-ai/sdk against that URL.

When idle for 30 min, Daytona auto-stops the sandbox.
On next request through the proxy, it auto-resumes.
All session data persists on disk across stop/start cycles.
```

## Quick Start (SDK)

```ts
import { ServerBox } from "@serverbox/sdk";
import { createOpencodeClient } from "@opencode-ai/sdk";

// 1. Create a sandboxed OpenCode instance
const sb = new ServerBox({
  daytonaApiKey: process.env.DAYTONA_API_KEY,
});

const instance = await sb.create({
  auth: {
    provider: "opencode",            // OpenCode Zen (default)
    apiKey: process.env.OPENCODE_ZEN_API_KEY,
  },
});

// 2. Use @opencode-ai/sdk directly against the returned URL
const connection = instance.getConnectionInfo();
const client = createOpencodeClient({
  baseUrl: connection.baseUrl,
  headers: connection.headers,
});

const session = await client.session.create({ body: { title: "demo" } });
const response = await client.session.prompt({
  path: { id: session.data.id },
  body: { parts: [{ type: "text", text: "Hello from ServerBox!" }] },
});

// 3. Lifecycle management
await instance.stop();    // sandbox stops, filesystem preserved
await instance.resume();  // sandbox restarts, all session data intact
await instance.destroy(); // permanently removed
await sb.close();
```

## Provider Auth

ServerBox defaults to **OpenCode Zen** but supports any provider OpenCode supports.

```ts
// OpenCode Zen (default — one key, 28+ models)
await sb.create({
  auth: { provider: "opencode", apiKey: "zen-key-..." },
});

// Anthropic
await sb.create({
  auth: { provider: "anthropic", apiKey: "sk-ant-..." },
  opencode: { model: "anthropic/claude-sonnet-4-5" },
});

// AWS Bedrock (env-based auth)
await sb.create({
  auth: {
    provider: "amazon-bedrock",
    env: {
      AWS_ACCESS_KEY_ID: "...",
      AWS_SECRET_ACCESS_KEY: "...",
      AWS_REGION: "us-east-1",
    },
  },
});

// Multiple providers at once
await sb.create({
  auth: [
    { provider: "opencode", apiKey: "zen-key-..." },
    { provider: "anthropic", apiKey: "sk-ant-..." },
  ],
});

// Custom OpenAI-compatible provider
await sb.create({
  auth: { provider: "my-provider", apiKey: "..." },
  opencode: {
    model: "my-provider/my-model",
    provider: {
      "my-provider": {
        npm: "@ai-sdk/openai-compatible",
        name: "My Provider",
        options: { baseURL: "https://api.myprovider.com/v1" },
        models: {
          "my-model": { name: "My Model", limit: { context: 200000, output: 65536 } },
        },
      },
    },
  },
});
```

## Instance API

```ts
instance.id            // unique instance ID
instance.sandboxId     // Daytona sandbox ID
instance.state         // "running" | "stopped" | "archived" | "error" | "destroyed"
instance.url           // public preview URL (null if not running)
instance.credentials   // { username, password } for OpenCode Basic Auth

// Lifecycle
await instance.stop();
await instance.resume({ timeout: 60_000 });
await instance.archive();
await instance.destroy();
await instance.health();   // { healthy: boolean, version: string }

// Shell commands inside the sandbox
await instance.exec("npm test");
// -> { exitCode, stdout, stderr }

// File operations
await instance.uploadFile("/workspace/fix.ts", code);
const buf = await instance.downloadFile("/workspace/output.txt");
```

## Proxy Mode

The proxy is for when you run ServerBox as a **shared backend service** instead of using the SDK directly in your app code.

**When you need it:**

- **Multi-tenant SaaS** — your web app creates sandbox instances for users. Each gets a stable `/i/<instance-id>` URL. The proxy handles auth injection, routing, and auto-resume.
- **Stable URLs** — without the proxy, your client needs to handle sandbox stop/resume. With the proxy, `/i/<instance-id>` always works — stopped sandboxes wake up transparently.
- **Centralized management** — one admin API to create, list, stop, resume, and destroy instances via HTTP. Multiple services or team members share the same pool.
- **Separate infra from app code** — your frontend only needs the proxy URL + an API key. No Daytona SDK, no sandbox orchestration logic.
- **Self-hosted deployment** — run as a Docker container. Persists metadata in SQLite across restarts.

**When you DON'T need it:**

- You're using `@serverbox/sdk` directly in a single Node/Bun process (script, CLI tool, backend that manages its own instances).

```bash
npm install @serverbox/proxy
```

```ts
import { ServerBoxProxy } from "@serverbox/proxy";

const proxy = new ServerBoxProxy({
  adminApiKey: process.env.SERVERBOX_ADMIN_API_KEY!,
  serverboxConfig: {
    daytonaApiKey: process.env.DAYTONA_API_KEY,
  },
});

await proxy.start(); // default: http://127.0.0.1:7788
```

### Admin API

All admin routes require `x-serverbox-admin-key` header.

| Method | Route | Description |
|---|---|---|
| `GET` | `/healthz` | Proxy health check |
| `POST` | `/admin/instances` | Create a new instance |
| `GET` | `/admin/instances` | List all instances |
| `GET` | `/admin/instances/:id` | Get one instance |
| `POST` | `/admin/instances/:id/resume` | Resume instance |
| `POST` | `/admin/instances/:id/stop` | Stop instance |
| `POST` | `/admin/instances/:id/archive` | Archive instance |
| `DELETE` | `/admin/instances/:id` | Destroy instance |

### Instance Proxy

All requests to `/i/:instanceId/*` are reverse-proxied to the sandbox's OpenCode server with auth headers injected automatically.

If the sandbox is stopped, the proxy auto-resumes it before forwarding the request (with in-flight deduplication to prevent thundering herd).

```bash
# Create an instance
curl -X POST http://127.0.0.1:7788/admin/instances \
  -H "content-type: application/json" \
  -H "x-serverbox-admin-key: $SERVERBOX_ADMIN_API_KEY" \
  -d '{ "auth": { "provider": "opencode", "apiKey": "'$OPENCODE_ZEN_API_KEY'" } }'

# Use the returned proxyUrl with @opencode-ai/sdk
# e.g. http://127.0.0.1:7788/i/<instance-id>
```

## Docker

```bash
# .env must contain: DAYTONA_API_KEY, OPENCODE_ZEN_API_KEY, SERVERBOX_ADMIN_API_KEY
docker compose up --build
```

Debug logging is enabled by default in compose (`SERVERBOX_LOG_LEVEL=debug`).

Tail logs:

```bash
docker compose logs -f serverbox-proxy
```

## Interactive CLI

An example interactive CLI is included for testing sandbox conversations:

```bash
bun run example:proxy-cli
```

Requires the proxy to be running (`docker compose up`). Supports:

- Send prompts and receive model responses
- `/help` `/new` `/attach <session-id>` `/status` `/stop` `/resume` `/id` `/exit`
- Reconnect to existing sessions: `bun run example:proxy-cli -- -s <session-id>`
- Keep instances after exit: `bun run example:proxy-cli -- --keep`

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `DAYTONA_API_KEY` | Yes | - | Daytona API key |
| `DAYTONA_API_URL` | No | `https://app.daytona.io/api` | Daytona API URL |
| `DAYTONA_TARGET` | No | `us` | Daytona target region |
| `OPENCODE_ZEN_API_KEY` | No | - | Default provider key for OpenCode Zen |
| `SERVERBOX_ADMIN_API_KEY` | Proxy | - | Admin API key for proxy routes |
| `SERVERBOX_LOG_LEVEL` | No | `info` | Log level (`debug`, `info`, `warn`, `error`) |
| `SERVERBOX_PROXY_REQUEST_LOGS` | No | `false` | Log all HTTP request/response details |
| `SERVERBOX_PROXY_PORT` | No | `7788` | Proxy listen port |
| `SERVERBOX_PROXY_HOST` | No | `0.0.0.0` | Proxy listen host |
| `SERVERBOX_PROXY_AUTO_RESUME` | No | `true` | Auto-resume stopped instances on proxy requests |
| `SERVERBOX_DB_PATH` | No | `./serverbox.db` | SQLite metadata store path |

## Testing

```bash
bun run test:unit                              # unit tests (mocked Daytona)
DAYTONA_API_KEY=... bun run test:integration   # real sandbox lifecycle
```

## License

MIT
