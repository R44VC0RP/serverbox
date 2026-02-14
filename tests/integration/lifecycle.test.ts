import { describe, expect, it } from "vitest";

import { ServerBox } from "../../packages/sdk/src/serverbox.js";

const hasDaytona = Boolean(process.env.DAYTONA_API_KEY);
const hasZen = Boolean(process.env.OPENCODE_ZEN_API_KEY || process.env.OPENCODE_API_KEY);

describe.skipIf(!hasDaytona || !hasZen)("integration lifecycle", () => {
  it(
    "creates, health-checks, stops, resumes, and destroys a real sandbox",
    async () => {
      const sb = new ServerBox({
        daytonaApiKey: process.env.DAYTONA_API_KEY
      });

      const instance = await sb.create({
        auth: {
          provider: "opencode",
          apiKey: process.env.OPENCODE_ZEN_API_KEY ?? process.env.OPENCODE_API_KEY
        }
      });

      try {
        const health = await instance.health();
        expect(health.healthy).toBe(true);

        await instance.stop();
        expect(instance.state).toBe("stopped");

        await instance.resume();
        expect(instance.state).toBe("running");
      } finally {
        await instance.destroy();
        await sb.close();
      }
    },
    300_000
  );
});
