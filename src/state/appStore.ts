import { create } from "zustand";
import { generateId } from "../data/id";
import { LocalSnapshotRepository } from "../data/repository";
import { createSeedSnapshot } from "../data/seed";
import type {
  AppSnapshot,
  AuthConfig,
  Collection,
  CollectionFolder,
  Environment,
  EnvironmentVariable,
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
  folderId?: string;
}

interface CreateFolderPayload {
  name: string;
  parentFolderId?: string;
}

interface UpdateWorkspaceGlobalsPayload {
  globalHeaders?: KeyValue[];
  globalVariables?: EnvironmentVariable[];
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
  selectEnvironment: (environmentId: string) => void;
  selectRequest: (requestId: string) => void;
  closeRequestTab: (requestId: string) => void;
  updateSelectedRequest: (payload: UpdateSelectedRequestPayload) => void;
  renameCollection: (collectionId: string, name: string) => void;
  duplicateCollection: (collectionId: string) => void;
  deleteCollection: (collectionId: string) => void;
  createRequest: (payload?: CreateRequestPayload) => void;
  createCollectionFolder: (payload: CreateFolderPayload) => void;
  renameCollectionFolder: (folderId: string, name: string) => void;
  deleteCollectionFolder: (folderId: string) => void;
  duplicateCollectionFolder: (folderId: string) => void;
  toggleCollectionFolder: (folderId: string) => void;
  moveCollectionFolder: (folderId: string, parentFolderId?: string) => void;
  moveRequestToFolder: (requestId: string, folderId?: string) => void;
  moveRequestsToFolder: (requestIds: string[], folderId?: string) => void;
  deleteRequest: (requestId: string) => void;
  deleteRequests: (requestIds: string[]) => void;
  duplicateRequest: (requestId: string) => void;
  duplicateRequests: (requestIds: string[]) => void;
  updateWorkspaceGlobals: (payload: UpdateWorkspaceGlobalsPayload) => void;
  recordHistory: (payload: RecordHistoryPayload) => void;
}

const repository = new LocalSnapshotRepository();

function buildRequestName(method: HttpMethod, url: string): string {
  if (!url.trim()) {
    return "New Request";
  }

  const normalized = url.replace(/^https?:\/\/[^/]+/, "");
  const path = normalized || "/";
  return `${method} ${path}`;
}

function normalizeWorkspace(workspace: Workspace): Workspace {
  return {
    ...workspace,
    globalHeaders: workspace.globalHeaders ?? [],
    globalVariables: workspace.globalVariables ?? [],
  };
}

function getRequestsByCollection(snapshot: AppSnapshot, collectionId: string): ApiRequest[] {
  return snapshot.requests.filter((request) => request.collectionId === collectionId);
}

function getCollectionsByWorkspace(snapshot: AppSnapshot, workspaceId: string): Collection[] {
  return snapshot.collections.filter((collection) => collection.workspaceId === workspaceId);
}

function getEnvironmentsByWorkspace(snapshot: AppSnapshot, workspaceId: string): Environment[] {
  return snapshot.environments.filter((environment) => environment.workspaceId === workspaceId);
}

function getDescendantFolderIds(folders: CollectionFolder[], folderId: string): string[] {
  const descendants: string[] = [folderId];
  const queue = [folderId];

  while (queue.length) {
    const current = queue.shift();
    if (!current) {
      continue;
    }

    folders.forEach((folder) => {
      if (folder.parentFolderId === current) {
        descendants.push(folder.id);
        queue.push(folder.id);
      }
    });
  }

  return descendants;
}

function ensureSelection(snapshot: AppSnapshot): AppSnapshot {
  const workspaces = snapshot.workspaces.map(normalizeWorkspace);
  const collectionFolders = snapshot.collectionFolders ?? [];

  const selectedWorkspace =
    workspaces.find((workspace) => workspace.id === snapshot.selectedWorkspaceId) ?? workspaces[0];
  const selectedWorkspaceId = selectedWorkspace?.id ?? "";

  const workspaceCollections = getCollectionsByWorkspace(
    { ...snapshot, workspaces, collectionFolders },
    selectedWorkspaceId,
  );
  const selectedCollection =
    workspaceCollections.find(
      (collection) => collection.id === snapshot.selectedCollectionId,
    ) ?? workspaceCollections[0];
  const selectedCollectionId = selectedCollection?.id ?? "";

  const collectionRequests = getRequestsByCollection(
    { ...snapshot, workspaces, collectionFolders },
    selectedCollectionId,
  );
  const selectedRequest =
    collectionRequests.find((request) => request.id === snapshot.selectedRequestId) ??
    collectionRequests[0];
  const selectedRequestId = selectedRequest?.id ?? "";

  const workspaceEnvironments = getEnvironmentsByWorkspace(
    { ...snapshot, workspaces, collectionFolders },
    selectedWorkspaceId,
  );
  const selectedEnvironment =
    workspaceEnvironments.find(
      (environment) => environment.id === snapshot.selectedEnvironmentId,
    ) ?? workspaceEnvironments[0];
  const selectedEnvironmentId = selectedEnvironment?.id ?? "";

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
    workspaces,
    collectionFolders,
    selectedWorkspaceId,
    selectedCollectionId,
    selectedRequestId,
    selectedEnvironmentId,
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

export function getFoldersForActiveCollection(snapshot: AppSnapshot): CollectionFolder[] {
  return (snapshot.collectionFolders ?? []).filter(
    (folder) => folder.collectionId === snapshot.selectedCollectionId,
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

export function getSelectedEnvironment(snapshot: AppSnapshot): Environment | undefined {
  return snapshot.environments.find(
    (environment) => environment.id === snapshot.selectedEnvironmentId,
  );
}

export function getGlobalHeadersForActiveWorkspace(snapshot: AppSnapshot): KeyValue[] {
  return getActiveWorkspace(snapshot)?.globalHeaders ?? [];
}

export function getGlobalVariablesForActiveWorkspace(snapshot: AppSnapshot): EnvironmentVariable[] {
  return getActiveWorkspace(snapshot)?.globalVariables ?? [];
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
          data: ensureSelection(createSeedSnapshot()),
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
        const selectedEnvironmentId =
          getEnvironmentsByWorkspace(snapshot, workspaceId)[0]?.id ?? "";

        return {
          ...snapshot,
          selectedWorkspaceId: workspaceId,
          selectedCollectionId,
          selectedRequestId,
          selectedEnvironmentId,
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

    selectEnvironment: (environmentId) => {
      updateSnapshot((snapshot) => ({
        ...snapshot,
        selectedEnvironmentId: environmentId,
      }));
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

    renameCollection: (collectionId, name) => {
      const nextName = name.trim();
      if (!nextName) {
        return;
      }

      updateSnapshot((snapshot) => ({
        ...snapshot,
        collections: snapshot.collections.map((collection) =>
          collection.id === collectionId
            ? {
                ...collection,
                name: nextName,
                updatedAt: new Date().toISOString(),
              }
            : collection,
        ),
      }));
    },

    duplicateCollection: (collectionId) => {
      updateSnapshot((snapshot) => {
        const sourceCollection = snapshot.collections.find(
          (collection) => collection.id === collectionId,
        );
        if (!sourceCollection) {
          return snapshot;
        }

        const now = new Date().toISOString();
        const nextCollectionId = generateId("col");
        const allFolders = snapshot.collectionFolders ?? [];
        const sourceFolders = allFolders.filter(
          (folder) => folder.collectionId === sourceCollection.id,
        );

        const folderIdMap = new Map<string, string>();
        const pending = [...sourceFolders];
        const duplicatedFolders: CollectionFolder[] = [];

        while (pending.length > 0) {
          let progressed = false;

          for (let index = 0; index < pending.length; index += 1) {
            const folder = pending[index];
            if (!folder.parentFolderId || folderIdMap.has(folder.parentFolderId)) {
              const nextFolderId = generateId("folder");
              folderIdMap.set(folder.id, nextFolderId);
              duplicatedFolders.push({
                ...folder,
                id: nextFolderId,
                collectionId: nextCollectionId,
                parentFolderId: folder.parentFolderId
                  ? folderIdMap.get(folder.parentFolderId)
                  : undefined,
                createdAt: now,
                updatedAt: now,
                expanded: true,
              });
              pending.splice(index, 1);
              index -= 1;
              progressed = true;
            }
          }

          if (!progressed) {
            break;
          }
        }

        const sourceRequests = snapshot.requests.filter(
          (request) => request.collectionId === sourceCollection.id,
        );
        const duplicatedRequests = sourceRequests.map((request) => ({
          ...request,
          id: generateId("req"),
          collectionId: nextCollectionId,
          folderId: request.folderId ? folderIdMap.get(request.folderId) : undefined,
          createdAt: now,
          updatedAt: now,
        }));
        const duplicatedRequestIds = duplicatedRequests.map((request) => request.id);

        return {
          ...snapshot,
          collections: [
            ...snapshot.collections,
            {
              ...sourceCollection,
              id: nextCollectionId,
              name: `${sourceCollection.name} Copy`,
              requestIds: duplicatedRequestIds,
              createdAt: now,
              updatedAt: now,
            },
          ],
          collectionFolders: [...allFolders, ...duplicatedFolders],
          requests: [...snapshot.requests, ...duplicatedRequests],
          selectedCollectionId: nextCollectionId,
          selectedRequestId: duplicatedRequestIds[0] ?? snapshot.selectedRequestId,
          openRequestIds: duplicatedRequestIds[0] ? [duplicatedRequestIds[0]] : [],
        };
      });
    },

    deleteCollection: (collectionId) => {
      updateSnapshot((snapshot) => {
        const requestIdsToDelete = new Set(
          snapshot.requests
            .filter((request) => request.collectionId === collectionId)
            .map((request) => request.id),
        );

        return {
          ...snapshot,
          collections: snapshot.collections.filter(
            (collection) => collection.id !== collectionId,
          ),
          collectionFolders: (snapshot.collectionFolders ?? []).filter(
            (folder) => folder.collectionId !== collectionId,
          ),
          requests: snapshot.requests.filter(
            (request) => request.collectionId !== collectionId,
          ),
          history: snapshot.history.filter(
            (entry) => !requestIdsToDelete.has(entry.requestId),
          ),
          openRequestIds: (snapshot.openRequestIds ?? []).filter(
            (id) => !requestIdsToDelete.has(id),
          ),
        };
      });
    },

    createRequest: (payload) => {
      updateSnapshot((snapshot) => {
        const now = new Date().toISOString();
        const method = payload?.method ?? "GET";
        const url = payload?.url ?? "";
        const requestId = generateId("req");

        const newRequest: ApiRequest = {
          id: requestId,
          workspaceId: snapshot.selectedWorkspaceId,
          collectionId: snapshot.selectedCollectionId,
          folderId: payload?.folderId,
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

    createCollectionFolder: (payload) => {
      updateSnapshot((snapshot) => {
        const now = new Date().toISOString();
        const folder: CollectionFolder = {
          id: generateId("folder"),
          workspaceId: snapshot.selectedWorkspaceId,
          collectionId: snapshot.selectedCollectionId,
          name: payload.name,
          parentFolderId: payload.parentFolderId,
          expanded: true,
          createdAt: now,
          updatedAt: now,
        };

        return {
          ...snapshot,
          collectionFolders: [...(snapshot.collectionFolders ?? []), folder],
        };
      });
    },

    renameCollectionFolder: (folderId, name) => {
      const nextName = name.trim();
      if (!nextName) {
        return;
      }

      updateSnapshot((snapshot) => ({
        ...snapshot,
        collectionFolders: (snapshot.collectionFolders ?? []).map((folder) =>
          folder.id === folderId
            ? {
                ...folder,
                name: nextName,
                updatedAt: new Date().toISOString(),
              }
            : folder,
        ),
      }));
    },

    deleteCollectionFolder: (folderId) => {
      updateSnapshot((snapshot) => {
        const allFolders = snapshot.collectionFolders ?? [];
        const target = allFolders.find((folder) => folder.id === folderId);
        if (!target) {
          return snapshot;
        }

        const descendantIds = new Set(getDescendantFolderIds(allFolders, folderId));
        const moveToFolderId = target.parentFolderId;

        return {
          ...snapshot,
          collectionFolders: allFolders.filter((folder) => !descendantIds.has(folder.id)),
          requests: snapshot.requests.map((request) =>
            request.collectionId === target.collectionId &&
            request.folderId &&
            descendantIds.has(request.folderId)
              ? {
                  ...request,
                  folderId: moveToFolderId,
                  updatedAt: new Date().toISOString(),
                }
              : request,
          ),
        };
      });
    },

    duplicateCollectionFolder: (folderId) => {
      updateSnapshot((snapshot) => {
        const allFolders = snapshot.collectionFolders ?? [];
        const rootFolder = allFolders.find((folder) => folder.id === folderId);
        if (!rootFolder) {
          return snapshot;
        }

        const sourceIds = getDescendantFolderIds(allFolders, folderId);
        const sourceSet = new Set(sourceIds);
        const now = new Date().toISOString();
        const idMap = new Map<string, string>();

        const duplicatedFolders = sourceIds
          .map((sourceId) => allFolders.find((folder) => folder.id === sourceId))
          .filter((folder): folder is CollectionFolder => Boolean(folder))
          .map((sourceFolder) => {
            const newId = generateId("folder");
            idMap.set(sourceFolder.id, newId);

            return {
              ...sourceFolder,
              id: newId,
              name:
                sourceFolder.id === rootFolder.id
                  ? `${sourceFolder.name} Copy`
                  : sourceFolder.name,
              parentFolderId:
                sourceFolder.parentFolderId && idMap.has(sourceFolder.parentFolderId)
                  ? idMap.get(sourceFolder.parentFolderId)
                  : sourceFolder.id === rootFolder.id
                    ? rootFolder.parentFolderId
                    : sourceFolder.parentFolderId,
              createdAt: now,
              updatedAt: now,
              expanded: true,
            };
          });

        const duplicatedRequests = snapshot.requests
          .filter(
            (request) =>
              request.collectionId === rootFolder.collectionId &&
              request.folderId &&
              sourceSet.has(request.folderId),
          )
          .map((request) => {
            const newRequestId = generateId("req");
            return {
              ...request,
              id: newRequestId,
              folderId: request.folderId ? idMap.get(request.folderId) : undefined,
              name: `${request.name} Copy`,
              createdAt: now,
              updatedAt: now,
            };
          });

        const duplicatedRequestIds = duplicatedRequests.map((request) => request.id);

        return {
          ...snapshot,
          collectionFolders: [...allFolders, ...duplicatedFolders],
          requests: [...snapshot.requests, ...duplicatedRequests],
          collections: snapshot.collections.map((collection) =>
            collection.id === rootFolder.collectionId
              ? {
                  ...collection,
                  requestIds: [...collection.requestIds, ...duplicatedRequestIds],
                  updatedAt: now,
                }
              : collection,
          ),
          selectedRequestId: duplicatedRequestIds[0] ?? snapshot.selectedRequestId,
          openRequestIds:
            duplicatedRequestIds.length > 0
              ? [
                  duplicatedRequestIds[0],
                  ...(snapshot.openRequestIds ?? []).filter(
                    (id) => id !== duplicatedRequestIds[0],
                  ),
                ]
              : snapshot.openRequestIds,
        };
      });
    },

    toggleCollectionFolder: (folderId) => {
      updateSnapshot((snapshot) => ({
        ...snapshot,
        collectionFolders: (snapshot.collectionFolders ?? []).map((folder) =>
          folder.id === folderId
            ? {
                ...folder,
                expanded: !(folder.expanded ?? true),
              }
            : folder,
        ),
      }));
    },

    moveCollectionFolder: (folderId, parentFolderId) => {
      updateSnapshot((snapshot) => {
        const allFolders = snapshot.collectionFolders ?? [];
        const movingFolder = allFolders.find((folder) => folder.id === folderId);
        if (!movingFolder) {
          return snapshot;
        }

        if (parentFolderId === folderId) {
          return snapshot;
        }

        if (parentFolderId) {
          const targetParent = allFolders.find((folder) => folder.id === parentFolderId);
          if (!targetParent) {
            return snapshot;
          }

          if (targetParent.collectionId !== movingFolder.collectionId) {
            return snapshot;
          }

          const descendants = new Set(getDescendantFolderIds(allFolders, folderId));
          if (descendants.has(parentFolderId)) {
            return snapshot;
          }
        }

        if ((movingFolder.parentFolderId ?? undefined) === parentFolderId) {
          return snapshot;
        }

        return {
          ...snapshot,
          collectionFolders: allFolders.map((folder) =>
            folder.id === folderId
              ? {
                  ...folder,
                  parentFolderId,
                  updatedAt: new Date().toISOString(),
                }
              : folder,
          ),
        };
      });
    },

    moveRequestToFolder: (requestId, folderId) => {
      updateSnapshot((snapshot) => {
        const targetRequest = snapshot.requests.find((request) => request.id === requestId);
        if (!targetRequest) {
          return snapshot;
        }

        const isFolderValid =
          !folderId ||
          (snapshot.collectionFolders ?? []).some(
            (folder) =>
              folder.id === folderId && folder.collectionId === targetRequest.collectionId,
          );
        if (!isFolderValid) {
          return snapshot;
        }

        return {
          ...snapshot,
          requests: snapshot.requests.map((request) =>
            request.id === requestId
              ? {
                  ...request,
                  folderId,
                  updatedAt: new Date().toISOString(),
                }
              : request,
          ),
        };
      });
    },

    moveRequestsToFolder: (requestIds, folderId) => {
      const uniqueIds = Array.from(new Set(requestIds));
      if (!uniqueIds.length) {
        return;
      }

      updateSnapshot((snapshot) => {
        const requestMap = new Map(
          snapshot.requests.map((request) => [request.id, request] as const),
        );

        const validIds = uniqueIds.filter((id) => requestMap.has(id));
        if (!validIds.length) {
          return snapshot;
        }

        if (folderId) {
          const targetFolder = (snapshot.collectionFolders ?? []).find(
            (folder) => folder.id === folderId,
          );
          if (!targetFolder) {
            return snapshot;
          }

          const hasInvalidCollection = validIds.some((id) => {
            const request = requestMap.get(id);
            return request?.collectionId !== targetFolder.collectionId;
          });
          if (hasInvalidCollection) {
            return snapshot;
          }
        }

        return {
          ...snapshot,
          requests: snapshot.requests.map((request) =>
            validIds.includes(request.id)
              ? {
                  ...request,
                  folderId,
                  updatedAt: new Date().toISOString(),
                }
              : request,
          ),
        };
      });
    },

    deleteRequest: (requestId) => {
      updateSnapshot((snapshot) => ({
        ...snapshot,
        requests: snapshot.requests.filter((request) => request.id !== requestId),
        collections: snapshot.collections.map((collection) => ({
          ...collection,
          requestIds: collection.requestIds.filter((id) => id !== requestId),
        })),
        openRequestIds: (snapshot.openRequestIds ?? []).filter((id) => id !== requestId),
      }));
    },

    deleteRequests: (requestIds) => {
      const ids = new Set(requestIds);
      if (!ids.size) {
        return;
      }

      updateSnapshot((snapshot) => ({
        ...snapshot,
        requests: snapshot.requests.filter((request) => !ids.has(request.id)),
        collections: snapshot.collections.map((collection) => ({
          ...collection,
          requestIds: collection.requestIds.filter((id) => !ids.has(id)),
        })),
        history: snapshot.history.filter((entry) => !ids.has(entry.requestId)),
        openRequestIds: (snapshot.openRequestIds ?? []).filter((id) => !ids.has(id)),
      }));
    },

    duplicateRequest: (requestId) => {
      updateSnapshot((snapshot) => {
        const source = snapshot.requests.find((request) => request.id === requestId);
        if (!source) {
          return snapshot;
        }

        const now = new Date().toISOString();
        const nextRequestId = generateId("req");
        const duplicated: ApiRequest = {
          ...source,
          id: nextRequestId,
          name: `${source.name} Copy`,
          createdAt: now,
          updatedAt: now,
        };

        return {
          ...snapshot,
          requests: [...snapshot.requests, duplicated],
          collections: snapshot.collections.map((collection) =>
            collection.id === source.collectionId
              ? {
                  ...collection,
                  requestIds: [...collection.requestIds, nextRequestId],
                  updatedAt: now,
                }
              : collection,
          ),
          selectedRequestId: nextRequestId,
          openRequestIds: [
            nextRequestId,
            ...(snapshot.openRequestIds ?? []).filter((id) => id !== nextRequestId),
          ],
        };
      });
    },

    duplicateRequests: (requestIds) => {
      const uniqueIds = Array.from(new Set(requestIds));
      if (!uniqueIds.length) {
        return;
      }

      updateSnapshot((snapshot) => {
        const sourceRequests = uniqueIds
          .map((id) => snapshot.requests.find((request) => request.id === id))
          .filter((request): request is ApiRequest => Boolean(request));
        if (!sourceRequests.length) {
          return snapshot;
        }

        const now = new Date().toISOString();
        const duplicates = sourceRequests.map((request) => ({
          ...request,
          id: generateId("req"),
          name: `${request.name} Copy`,
          createdAt: now,
          updatedAt: now,
        }));

        const duplicateIds = duplicates.map((request) => request.id);
        const duplicatesByCollection = new Map<string, string[]>();

        duplicates.forEach((request) => {
          const existing = duplicatesByCollection.get(request.collectionId) ?? [];
          duplicatesByCollection.set(request.collectionId, [...existing, request.id]);
        });

        return {
          ...snapshot,
          requests: [...snapshot.requests, ...duplicates],
          collections: snapshot.collections.map((collection) => ({
            ...collection,
            requestIds: [
              ...collection.requestIds,
              ...(duplicatesByCollection.get(collection.id) ?? []),
            ],
            updatedAt: duplicatesByCollection.has(collection.id)
              ? now
              : collection.updatedAt,
          })),
          selectedRequestId: duplicateIds[0] ?? snapshot.selectedRequestId,
          openRequestIds: duplicateIds[0]
            ? [
                duplicateIds[0],
                ...(snapshot.openRequestIds ?? []).filter((id) => id !== duplicateIds[0]),
              ]
            : snapshot.openRequestIds,
        };
      });
    },

    updateWorkspaceGlobals: (payload) => {
      updateSnapshot((snapshot) => ({
        ...snapshot,
        workspaces: snapshot.workspaces.map((workspace) =>
          workspace.id === snapshot.selectedWorkspaceId
            ? {
                ...workspace,
                globalHeaders: payload.globalHeaders ?? workspace.globalHeaders ?? [],
                globalVariables: payload.globalVariables ?? workspace.globalVariables ?? [],
                updatedAt: new Date().toISOString(),
              }
            : workspace,
        ),
      }));
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
