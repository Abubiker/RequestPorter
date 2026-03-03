const hasCryptoUuid =
  typeof globalThis.crypto !== "undefined" &&
  typeof globalThis.crypto.randomUUID === "function";

export function generateId(prefix: string): string {
  if (hasCryptoUuid) {
    return `${prefix}_${globalThis.crypto.randomUUID()}`;
  }

  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}
