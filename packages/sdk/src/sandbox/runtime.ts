import { ServerBoxError, type ExecOptions, type ExecResult } from "@serverbox/core";

function getProcessApi(sandbox: any): any {
  if (!sandbox?.process) {
    throw new ServerBoxError("UNSUPPORTED_OPERATION", "Sandbox process API is unavailable.");
  }
  return sandbox.process;
}

function getFsApi(sandbox: any): any {
  if (!sandbox?.fs) {
    throw new ServerBoxError("UNSUPPORTED_OPERATION", "Sandbox filesystem API is unavailable.");
  }
  return sandbox.fs;
}

function toNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function resolveExitCode(result: any): number {
  if (typeof result?.exitCode === "number") return result.exitCode;
  if (typeof result?.exit_code === "number") return result.exit_code;
  if (typeof result?.artifacts?.exitCode === "number") return result.artifacts.exitCode;
  if (typeof result?.artifacts?.exit_code === "number") return result.artifacts.exit_code;
  return 0;
}

function resolveStdout(result: any): string {
  if (typeof result?.result === "string") return result.result;
  if (typeof result?.stdout === "string") return result.stdout;
  if (typeof result?.artifacts?.stdout === "string") return result.artifacts.stdout;
  return "";
}

function resolveStderr(result: any): string {
  if (typeof result?.stderr === "string") return result.stderr;
  if (typeof result?.artifacts?.stderr === "string") return result.artifacts.stderr;
  return "";
}

export async function executeSandboxCommand(
  sandbox: any,
  command: string,
  options: ExecOptions = {}
): Promise<ExecResult> {
  const processApi = getProcessApi(sandbox);
  if (typeof processApi.executeCommand !== "function") {
    throw new ServerBoxError(
      "UNSUPPORTED_OPERATION",
      "Sandbox process.executeCommand() is unavailable."
    );
  }

  const result = await processApi.executeCommand(
    command,
    options.cwd,
    options.env,
    options.timeout
  );

  return {
    exitCode: toNumber(resolveExitCode(result), 0),
    stdout: resolveStdout(result),
    stderr: resolveStderr(result)
  };
}

export async function uploadFileToSandbox(
  sandbox: any,
  remotePath: string,
  content: Buffer | string
): Promise<void> {
  const fsApi = getFsApi(sandbox);
  if (typeof fsApi.uploadFile !== "function") {
    throw new ServerBoxError("UNSUPPORTED_OPERATION", "Sandbox fs.uploadFile() is unavailable.");
  }

  await fsApi.uploadFile(Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8"), remotePath);
}

export async function downloadFileFromSandbox(sandbox: any, remotePath: string): Promise<Buffer> {
  const fsApi = getFsApi(sandbox);
  if (typeof fsApi.downloadFile !== "function") {
    throw new ServerBoxError("UNSUPPORTED_OPERATION", "Sandbox fs.downloadFile() is unavailable.");
  }

  const output = await fsApi.downloadFile(remotePath);
  if (Buffer.isBuffer(output)) return output;
  if (typeof output === "string") return Buffer.from(output, "utf8");

  if (output instanceof Uint8Array) {
    return Buffer.from(output);
  }

  throw new ServerBoxError(
    "DAYTONA_API_ERROR",
    `Unsupported file download response type for '${remotePath}'.`
  );
}

export async function restartSessionCommand(
  sandbox: any,
  sessionId: string,
  command: string
): Promise<void> {
  const processApi = getProcessApi(sandbox);
  if (
    typeof processApi.createSession !== "function" ||
    typeof processApi.executeSessionCommand !== "function"
  ) {
    throw new ServerBoxError(
      "UNSUPPORTED_OPERATION",
      "Sandbox process session APIs are unavailable."
    );
  }

  if (typeof processApi.deleteSession === "function") {
    try {
      await processApi.deleteSession(sessionId);
    } catch {
      // Session might not exist yet.
    }
  }

  await processApi.createSession(sessionId);
  await processApi.executeSessionCommand(sessionId, {
    command,
    async: true
  });
}
