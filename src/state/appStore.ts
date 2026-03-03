import { create } from "zustand";
import { generateId } from "../data/id";
import { LocalSnapshotRepository } from "../data/repository";
import { createSeedSnapshot } from "../data/seed";
import type {
  AppSnapshot,
  AuthConfig,
  Collection,
  Environment,
  ApiRequest,
  HttpMethod,
  KeyValue,
  LatestResponseSummary,
  SidebarSection,
  Workspace,
} from "../domain/models";

interface UpdateSelectedRequestPayload {
  method?: HttpMethod;
  url?: string;
  body?: string;
  headers?: KeyValue[];
  queryParams?: KeyValue[];
  auth?: AuthConfig;
}

interface CreateRequestPayload {
  method?: HttpMethod;
  url?: string;
  body?: string;
  headers?: KeyValue[];
  queryParams?: KeyValue[];
  auth?: AuthConfig;
  name?: string;
}

interface RecordHistoryPayload {
  requestId: string;
  method: HttpMethod;
  url: string;
  statusCode: number;
  durationMs: number;
  responseSizeBytes: number;
}

interface AppStoreState {
  isLoaded: boolean;
  isSaving: boolean;
  errorMessage: string | null;
  activeSection: SidebarSection;
  latestResponse: LatestResponseSummary | null;
  data: AppSnapshot;
  load: () => Promise<void>;
  setActiveSection: (section: SidebarSection) => void;
  selectWorkspace: (workspaceId: string) => void;
  selectCollection: (collectionId: string) => void;
  selectRequest: (requestId: string) => void;
  closeRequestTab: (requestId: string) => void;
  updateSelectedRequest: (payload: UpdateSelectedRequestPayload) => void;
  createRequest: (payload?: CreateRequestPayload) => void;
  recordHistory: (payload: RecordHistoryPayload) => void;
}

const repository = new LocalSnapshotRepository();

function buildRequestName(method: HttpMethod, url: string): string {
  try {
    const parsed = new URL(url);
    const path = `${parsed.pathname}${parsed.search}` || "/";
    return `${method} ${path}`;
  } catch {
    const path = url.replace(/^https?:\/\/[^/]+/, "");
    return `${method} ${path || "/"}`;
  }
}

function getRequestsByCollection(snapshot: AppSnapshot, collectionId: string): ApiRequest[] {
  return snapshot.requests.filter((request) => request.collectionId === collectionId);
}

function getCollectionsByWorkspace(snapshot: AppSnapshot, workspaceId: string): Collection[] {
  return snapshot.collections.filter((collection) => collection.workspaceId === workspaceId);
}

function ensureSelection(snapshot: AppSnapshot): AppSnapshot {
  const selectedWorkspace =
    snapshot.workspaces.find((workspace) => workspace.id === snapshot.selectedWorkspaceId) ??
    snapshot.workspaces[0];

  const selectedWorkspaceId = selectedWorkspace?.id ?? "";
  const workspaceCollections = getCollectionsByWorkspace(snapshot, selectedWorkspaceId);

  const selectedCollection =
    workspaceCollections.find(
      (collection) => collection.id === snapshot.selectedCollectionId,
    ) ?? workspaceCollections[0];
  const selectedCollectionId = selectedCollection?.id ?? "";

  const collectionRequests = getRequestsByCollection(snapshot, selectedCollectionId);
  const selectedRequest =
    collectionRequests.find((request) => request.id === snapshot.selectedRequestId) ??
    collectionRequests[0];
  const selectedRequestId = selectedRequest?.id ?? "";

  const validRequestIds = new Set(collectionRequests.map((request) => request.id));
  let openRequestIds = (snapshot.openRequestIds ?? []).filter((id) => validRequestIds.has(id));

  if (selectedRequestId && !openRequestIds.includes(selectedRequestId)) {
    openRequestIds = [selectedRequestId, ...openRequestIds];
  }

  if (openRequestIds.length === 0 && selectedRequestId) {
    openRequestIds = [selectedRequestId];
  }

  return {
    ...snapshot,
    selectedWorkspaceId,
    selectedCollectionId,
    selectedRequestId,
    openRequestIds,
  };
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return "Unknown storage error";
}

export function getActiveWorkspace(snapshot: AppSnapshot): Workspace | undefined {
  return snapshot.workspaces.find((workspace) => workspace.id === snapshot.selectedWorkspaceId);
}

export function getCollectionsForActiveWorkspace(snapshot: AppSnapshot): Collection[] {
  return getCollectionsByWorkspace(snapshot, snapshot.selectedWorkspaceId);
}

export function getActiveCollection(snapshot: AppSnapshot): Collection | undefined {
  return snapshot.collections.find(
    (collection) => collection.id === snapshot.selectedCollectionId,
  );
}

export function getRequestsForActiveCollection(snapshot: AppSnapshot): ApiRequest[] {
  return getRequestsByCollection(snapshot, snapshot.selectedCollectionId);
}

export function getOpenRequests(snapshot: AppSnapshot): ApiRequest[] {
  const requestsById = new Map(snapshot.requests.map((request) => [request.id, request]));
  const openRequests = (snapshot.openRequestIds ?? [])
    .map((id) => requestsById.get(id))
    .filter((request): request is ApiRequest => Boolean(request));

  if (openRequests.length) {
    return openRequests;
  }

  const active = snapshot.requests.find((request) => request.id === snapshot.selectedRequestId);
  return active ? [active] : [];
}

export function getActiveRequest(snapshot: AppSnapshot): ApiRequest | undefined {
  return snapshot.requests.find((request) => request.id === snapshot.selectedRequestId);
}

export function getEnvironmentsForActiveWorkspace(snapshot: AppSnapshot): Environment[] {
  return snapshot.environments.filter(
    (environment) => environment.workspaceId === snapshot.selectedWorkspaceId,
  );
}

export const useAppStore = create<AppStoreState>((set) => {
  const persistSnapshot = async (snapshot: AppSnapshot): Promise<void> => {
    set({ isSaving: true });
    try {
      await repository.saveSnapshot(snapshot);
      set({ isSaving: false, errorMessage: null });
    } catch (error) {
      set({ isSaving: false, errorMessage: getErrorMessage(error) });
    }
  };

  const updateSnapshot = (updater: (snapshot: AppSnapshot) => AppSnapshot): void => {
    set((state) => {
      const nextSnapshot = ensureSelection(updater(state.data));
      void persistSnapshot(nextSnapshot);
      return {
        data: nextSnapshot,
      };
    });
  };

  return {
    isLoaded: false,
    isSaving: false,
    errorMessage: null,
    activeSection: "Collections",
    latestResponse: null,
    data: createSeedSnapshot(),

    load: async () => {
      try {
        const loadedSnapshot = await repository.loadSnapshot();
        set({
          data: ensureSelection(loadedSnapshot),
          isLoaded: true,
          errorMessage: null,
        });
      } catch (error) {
        set({
          data: createSeedSnapshot(),
          isLoaded: true,
          errorMessage: getErrorMessage(error),
        });
      }
    },

    setActiveSection: (section) => {
      set({ activeSection: section });
    },

    selectWorkspace: (workspaceId) => {
      updateSnapshot((snapshot) => {
        const workspaceCollections = getCollectionsByWorkspace(snapshot, workspaceId);
        const selectedCollectionId = workspaceCollections[0]?.id ?? "";
        const selectedRequestId =
          getRequestsByCollection(snapshot, selectedCollectionId)[0]?.id ?? "";

        return {
          ...snapshot,
          selectedWorkspaceId: workspaceId,
          selectedCollectionId,
          selectedRequestId,
          openRequestIds: selectedRequestId ? [selectedRequestId] : [],
        };
      });
    },

    selectCollection: (collectionId) => {
      updateSnapshot((snapshot) => {
        const selectedRequestId = getRequestsByCollection(snapshot, collectionId)[0]?.id ?? "";

        return {
          ...snapshot,
          selectedCollectionId: collectionId,
          selectedRequestId,
          openRequestIds: selectedRequestId ? [selectedRequestId] : [],
        };
      });
    },

    selectRequest: (requestId) => {
      updateSnapshot((snapshot) => {
        const openRequestIds = [
          requestId,
          ...(snapshot.openRequestIds ?? []).filter((id) => id !== requestId),
        ];

        return {
          ...snapshot,
          selectedRequestId: requestId,
          openRequestIds,
        };
      });
    },

    closeRequestTab: (requestId) => {
      updateSnapshot((snapshot) => {
        const remaining = (snapshot.openRequestIds ?? []).filter((id) => id !== requestId);
        const fallbackRequestId =
          getRequestsByCollection(snapshot, snapshot.selectedCollectionId)[0]?.id ?? "";

        const nextSelected =
          snapshot.selectedRequestId === requestId
            ? remaining[0] ?? fallbackRequestId
            : snapshot.selectedRequestId;

        return {
          ...snapshot,
          selectedRequestId: nextSelected,
          openRequestIds: remaining,
        };
      });
    },

    updateSelectedRequest: (payload) => {
      updateSnapshot((snapshot) => {
        const selectedRequestId = snapshot.selectedRequestId;
        const now = new Date().toISOString();

        return {
          ...snapshot,
          requests: snapshot.requests.map((request) => {
            if (request.id !== selectedRequestId) {
              return request;
            }

            const nextMethod = payload.method ?? request.method;
            const nextUrl = payload.url ?? request.url;
            const nextName = buildRequestName(nextMethod, nextUrl);

            return {
              ...request,
              method: nextMethod,
              url: nextUrl,
              body: payload.body ?? request.body,
              headers: payload.headers ?? request.headers,
              queryParams: payload.queryParams ?? request.queryParams,
              auth: payload.auth ?? request.auth,
              name: nextName,
              updatedAt: now,
            };
          }),
        };
      });
    },

    createRequest: (payload) => {
      updateSnapshot((snapshot) => {
        const now = new Date().toISOString();
        const method = payload?.method ?? "GET";
        const url = payload?.url ?? "https://jsonplaceholder.typicode.com/todos/1";
        const requestId = generateId("req");

        const newRequest: ApiRequest = {
          id: requestId,
          workspaceId: snapshot.selectedWorkspaceId,
          collectionId: snapshot.selectedCollectionId,
          name: payload?.name ?? buildRequestName(method, url),
          method,
          url,
          headers: payload?.headers ?? [],
          queryParams: payload?.queryParams ?? [],
          auth: payload?.auth ?? { type: "none" },
          body: payload?.body ?? "",
          createdAt: now,
          updatedAt: now,
        };

        return {
          ...snapshot,
          requests: [...snapshot.requests, newRequest],
          collections: snapshot.collections.map((collection) => {
            if (collection.id !== snapshot.selectedCollectionId) {
              return collection;
            }

            return {
              ...collection,
              requestIds: [...collection.requestIds, requestId],
              updatedAt: now,
            };
          }),
          selectedRequestId: requestId,
          openRequestIds: [
            requestId,
            ...(snapshot.openRequestIds ?? []).filter((id) => id !== requestId),
          ],
        };
      });
    },

    recordHistory: (payload) => {
      const historyEntry = {
        id: generateId("history"),
        workspaceId: "",
        requestId: payload.requestId,
        method: payload.method,
        url: payload.url,
        statusCode: payload.statusCode,
        durationMs: payload.durationMs,
        responseSizeBytes: payload.responseSizeBytes,
        timestamp: new Date().toISOString(),
      };

      set((state) => {
        const request = state.data.requests.find((item) => item.id === payload.requestId);
        const workspaceId = request?.workspaceId ?? state.data.selectedWorkspaceId;
        const nextEntry = {
          ...historyEntry,
          workspaceId,
        };

        const nextSnapshot = ensureSelection({
          ...state.data,
          history: [nextEntry, ...state.data.history].slice(0, 500),
        });
        void persistSnapshot(nextSnapshot);

        return {
          ...state,
          data: nextSnapshot,
          latestResponse: {
            statusCode: payload.statusCode,
            durationMs: payload.durationMs,
            responseSizeBytes: payload.responseSizeBytes,
            timestamp: nextEntry.timestamp,
          },
        };
      });
    },
  };
});
