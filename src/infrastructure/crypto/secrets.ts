import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** A random token, URL-safe: API keys, invitation links. */
export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");

export const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** Compares two strings in constant time, so a wrong token's timing says nothing about the right one. */
export function sameSecret(a: string, b: string): boolean {
  const [left, right] = [Buffer.from(a), Buffer.from(b)];
  return left.length === right.length && timingSafeEqual(left, right);
}
