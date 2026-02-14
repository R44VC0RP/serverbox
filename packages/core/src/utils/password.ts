import { randomBytes } from "node:crypto";

export function generatePassword(length: number): string {
  const bytes = randomBytes(Math.ceil(length * 0.75));
  return bytes.toString("base64url").slice(0, length);
}
