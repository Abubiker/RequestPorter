import type { AppSnapshot } from "../domain/models";
import { createSeedSnapshot } from "./seed";

const STORAGE_KEY = "requestporter.snapshot.v1";

function hasStorage(): boolean {
  return (
    typeof globalThis.window !== "undefined" &&
    typeof globalThis.window.localStorage !== "undefined"
  );
}

function isSnapshot(data: unknown): data is AppSnapshot {
  if (!data || typeof data !== "object") {
    return false;
  }

  const candidate = data as Partial<AppSnapshot>;

  return (
    candidate.version === 1 &&
    Array.isArray(candidate.workspaces) &&
    Array.isArray(candidate.collections) &&
    Array.isArray(candidate.requests) &&
    Array.isArray(candidate.environments) &&
    Array.isArray(candidate.history) &&
    typeof candidate.selectedWorkspaceId === "string" &&
    typeof candidate.selectedCollectionId === "string" &&
    typeof candidate.selectedRequestId === "string"
  );
}

export interface SnapshotRepository {
  loadSnapshot: () => Promise<AppSnapshot>;
  saveSnapshot: (snapshot: AppSnapshot) => Promise<void>;
  clearSnapshot: () => Promise<void>;
}

export class LocalSnapshotRepository implements SnapshotRepository {
  async loadSnapshot(): Promise<AppSnapshot> {
    if (!hasStorage()) {
      return createSeedSnapshot();
    }

    const raw = globalThis.window.localStorage.getItem(STORAGE_KEY);

    if (!raw) {
      const seed = createSeedSnapshot();
      await this.saveSnapshot(seed);
      return seed;
    }

    try {
      const parsed: unknown = JSON.parse(raw);
      if (isSnapshot(parsed)) {
        return parsed;
      }
    } catch {
      // Fall through and reset invalid data.
    }

    const seed = createSeedSnapshot();
    await this.saveSnapshot(seed);
    return seed;
  }

  async saveSnapshot(snapshot: AppSnapshot): Promise<void> {
    if (!hasStorage()) {
      return;
    }

    globalThis.window.localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
  }

  async clearSnapshot(): Promise<void> {
    if (!hasStorage()) {
      return;
    }

    globalThis.window.localStorage.removeItem(STORAGE_KEY);
  }
}
