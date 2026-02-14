import type { IncomingMessage } from "node:http";

export function getHeader(req: IncomingMessage, key: string): string | null {
  const value = req.headers[key.toLowerCase()];
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }
  return typeof value === "string" ? value : null;
}

export function checkApiKey(req: IncomingMessage, headerName: string, expected: string): boolean {
  const actual = getHeader(req, headerName);
  return typeof actual === "string" && actual.length > 0 && actual === expected;
}
