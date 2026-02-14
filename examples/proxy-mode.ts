import { ServerBoxProxy } from "@serverbox/proxy";

async function main(): Promise<void> {
  const proxy = new ServerBoxProxy({
    adminApiKey: process.env.SERVERBOX_ADMIN_API_KEY ?? "dev-admin-key",
    proxyApiKey: process.env.SERVERBOX_PROXY_API_KEY,
    serverboxConfig: {
      daytonaApiKey: process.env.DAYTONA_API_KEY
    }
  });

  const started = await proxy.start();
  console.log(`Proxy listening on ${started.url}`);

  const createResponse = await fetch(`${started.url}/admin/instances`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-serverbox-admin-key": process.env.SERVERBOX_ADMIN_API_KEY ?? "dev-admin-key"
    },
    body: JSON.stringify({
      auth: {
        provider: "opencode",
        apiKey: process.env.OPENCODE_ZEN_API_KEY
      }
    })
  });

  if (!createResponse.ok) {
    throw new Error(`Failed to create instance: ${createResponse.status}`);
  }

  const payload = (await createResponse.json()) as {
    instance: { id: string; proxyUrl: string };
  };

  console.log(`Instance id: ${payload.instance.id}`);
  console.log(`Stable proxy URL: ${payload.instance.proxyUrl}`);

  // This stable URL is what you give clients to use with @opencode-ai/sdk
  // Example base URL: http://127.0.0.1:7788/i/<instance-id>
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
