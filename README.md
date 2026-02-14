# ServerBox

ServerBox is a TypeScript SDK for managing sandboxed OpenCode servers on Daytona.

It handles sandbox lifecycle and infrastructure only. Consumers should use `@opencode-ai/sdk` directly against the returned URL.

## Quick Start

```bash
bun install
bun run build
bun run test
```

Required env: `DAYTONA_API_KEY`.

Optional Daytona overrides: `DAYTONA_API_URL`, `DAYTONA_TARGET`.

`SERVERBOX_ADMIN_API_KEY` is required for proxy mode.

## Run With Docker

1. Ensure `.env` contains at least:
   - `DAYTONA_API_KEY`
   - `OPENCODE_ZEN_API_KEY` (or pass auth via admin create payload)
   - `SERVERBOX_ADMIN_API_KEY`
2. Start the proxy:

```bash
docker compose up --build
```

Verbose container logs are enabled by default in compose:

- `SERVERBOX_LOG_LEVEL=debug`
- `SERVERBOX_PROXY_REQUEST_LOGS=true`

Tail logs:

```bash
docker compose logs -f serverbox-proxy
```

3. Health check:

```bash
curl http://127.0.0.1:7788/healthz
```

4. Create an instance through admin API:

```bash
curl -X POST http://127.0.0.1:7788/admin/instances \
  -H "content-type: application/json" \
  -H "x-serverbox-admin-key: $SERVERBOX_ADMIN_API_KEY" \
  -d '{
    "auth": {
      "provider": "opencode",
      "apiKey": "'$OPENCODE_ZEN_API_KEY'"
    }
  }'
```

The response includes an `instance.proxyUrl` like `http://127.0.0.1:7788/i/<instance-id>`.

5. Run the end-to-end proxy + OpenCode SDK example:

```bash
bun run example:proxy-cli
```

This starts an interactive CLI that sends prompts through `@opencode-ai/sdk` to `instance.proxyUrl`.
Useful commands in the CLI: `/help`, `/new`, `/attach <session-id>`, `/status`, `/stop`, `/resume`, `/id`, `/exit`.

Reconnect to an existing OpenCode session:

```bash
bun run example:proxy-cli -- -s <session-id>
```

Optionally restrict reconnect lookup to one instance:

```bash
bun run example:proxy-cli -- -i <instance-id> -s <session-id>
```

Optional env:

- `SERVERBOX_INSTANCE_ID=<id>` to reuse an existing instance
- `SERVERBOX_KEEP_INSTANCE=true` to keep created instance after exit
- `OPENCODE_PROVIDER` and `OPENCODE_PROVIDER_API_KEY` to create with a non-Zen provider

## Usage

```ts
import { ServerBox } from "@serverbox/sdk";

const serverbox = new ServerBox({
  daytonaApiKey: process.env.DAYTONA_API_KEY
});

const instance = await serverbox.create({
  auth: {
    provider: "opencode",
    apiKey: process.env.OPENCODE_ZEN_API_KEY
  }
});

const connection = instance.getConnectionInfo();
console.log(connection.baseUrl);
console.log(connection.headers); // includes Basic auth + preview token

await instance.stop();
await instance.resume();
await instance.destroy();
await serverbox.close();
```

Use `connection.baseUrl` and `connection.headers` with `@opencode-ai/sdk` directly.

## Proxy Mode (Phase 4)

Proxy mode gives you stable per-instance URLs and auto-resume.

```ts
import { ServerBoxProxy } from "@serverbox/proxy";

const proxy = new ServerBoxProxy({
  adminApiKey: process.env.SERVERBOX_ADMIN_API_KEY!,
  // optional. If omitted, proxy routes reuse adminApiKey.
  // set to null to disable proxy auth on /i/:instanceId/*
  proxyApiKey: process.env.SERVERBOX_PROXY_API_KEY,
  serverboxConfig: {
    daytonaApiKey: process.env.DAYTONA_API_KEY
  }
});

const started = await proxy.start();

// Create instance through admin API
await fetch(`${started.url}/admin/instances`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-serverbox-admin-key": process.env.SERVERBOX_ADMIN_API_KEY!
  },
  body: JSON.stringify({
    auth: {
      provider: "opencode",
      apiKey: process.env.OPENCODE_ZEN_API_KEY
    }
  })
});

// Client base URL shape:
// http://<proxy-host>:<proxy-port>/i/<instance-id>
// If proxyApiKey is enabled, send x-serverbox-proxy-key on requests.
// By default, proxyApiKey reuses SERVERBOX_ADMIN_API_KEY.
```

Routes:

- `GET /healthz` - proxy health
- `POST /admin/instances` - create instance
- `GET /admin/instances` - list instances
- `GET /admin/instances/:id` - get one instance
- `POST /admin/instances/:id/resume` - resume one instance
- `POST /admin/instances/:id/stop` - stop one instance
- `POST /admin/instances/:id/archive` - archive one instance
- `DELETE /admin/instances/:id` - destroy one instance
- `/i/:instanceId/*` - reverse proxy to sandbox OpenCode server (auto-resume enabled by default)

## Testing

- Unit tests: `bun run test:unit`
- Integration tests (requires Daytona + OpenCode keys): `bun run test:integration`

## Publishing

If you want to publish under `@serverbox/*`, you must own the `serverbox` npm scope (npm org/user).

1. Login:

```bash
npm login
npm whoami
```

2. Dry run publish:

```bash
bun run release:npm -- --version 0.1.0 --dry-run
```

3. Publish:

```bash
bun run release:npm -- --version 0.1.0
```

The release script publishes in order: `@serverbox/core`, `@serverbox/sdk`, `@serverbox/proxy`.

## Packages

- `@serverbox/core` - shared types, errors, constants, SQLite metadata store
- `@serverbox/sdk` - ServerBox manager and instance lifecycle operations
- `@serverbox/proxy` - stable URL reverse proxy with admin API and auto-resume
