import { ServerBox } from "@serverbox/sdk";

async function main(): Promise<void> {
  const serverBox = new ServerBox({
    daytonaApiKey: process.env.DAYTONA_API_KEY
  });

  const instance = await serverBox.create({
    auth: {
      provider: "opencode",
      apiKey: process.env.OPENCODE_ZEN_API_KEY
    }
  });

  const connection = instance.getConnectionInfo();
  console.log("OpenCode base URL:", connection.baseUrl);
  console.log("Connection headers are ready for @opencode-ai/sdk usage.");

  await instance.stop();
  await instance.destroy();
  await serverBox.close();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
