import { createHash } from "node:crypto";

// Fixed namespace for ids derived from client-supplied ids.
const NAMESPACE = "6f1c7a52-3d0e-4b8a-9c1e-2a7b5d4e8f90";

/** RFC 4122 version-5 UUID: the same name always yields the same id. */
export function uuidV5(name: string, namespace = NAMESPACE): string {
  const ns = Buffer.from(namespace.replace(/-/g, ""), "hex");
  const hash = createHash("sha1").update(ns).update(name).digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
