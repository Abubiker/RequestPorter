import type {
  AppSnapshot,
  Collection,
  CollectionFolder,
  Environment,
  ApiRequest,
  Workspace,
} from "../domain/models";

function nowIso(): string {
  return new Date().toISOString();
}

function buildWorkspace(now: string): Workspace {
  return {
    id: "ws_primary",
    name: "Primary Workspace",
    type: "personal",
    members: [
      {
        id: "member_owner",
        name: "Owner",
        email: "owner@requestporter.local",
        role: "owner",
      },
    ],
    globalVariables: [
      {
        id: "ws_var_base_url",
        key: "baseUrl",
        value: "https://jsonplaceholder.typicode.com",
        enabled: true,
      },
      {
        id: "ws_var_auth_token",
        key: "authToken",
        value: "demo-token",
        enabled: true,
      },
    ],
    globalHeaders: [
      {
        id: "ws_header_app",
        key: "X-App-Client",
        value: "RequestPorter",
        enabled: true,
      },
    ],
    createdAt: now,
    updatedAt: now,
  };
}

function buildCollection(workspaceId: string, now: string): Collection {
  return {
    id: "col_core",
    workspaceId,
    name: "Public APIs",
    requestIds: ["req_health", "req_login"],
    createdAt: now,
    updatedAt: now,
  };
}

function buildCollectionFolders(
  workspaceId: string,
  collectionId: string,
  now: string,
): CollectionFolder[] {
  return [
    {
      id: "folder_users",
      workspaceId,
      collectionId,
      name: "Users",
      expanded: true,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "folder_posts",
      workspaceId,
      collectionId,
      name: "Posts",
      expanded: true,
      createdAt: now,
      updatedAt: now,
    },
  ];
}

function buildRequests(workspaceId: string, collectionId: string, now: string): ApiRequest[] {
  return [
    {
      id: "req_health",
      workspaceId,
      collectionId,
      folderId: "folder_users",
      name: "GET {{baseUrl}}/todos/1",
      method: "GET",
      url: "{{baseUrl}}/todos/1",
      headers: [],
      queryParams: [],
      auth: { type: "none" },
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "req_login",
      workspaceId,
      collectionId,
      folderId: "folder_posts",
      name: "POST {{baseUrl}}/posts",
      method: "POST",
      url: "{{baseUrl}}/posts",
      headers: [
        {
          id: "header_content_type",
          key: "Content-Type",
          value: "application/json",
          enabled: true,
        },
      ],
      queryParams: [],
      auth: { type: "bearer", value: "{{authToken}}" },
      body: '{"title":"RequestPorter","body":"hello from desktop app","userId":1}',
      createdAt: now,
      updatedAt: now,
    },
  ];
}

function buildEnvironments(workspaceId: string, now: string): Environment[] {
  return [
    {
      id: "env_dev",
      workspaceId,
      name: "dev",
      variables: [
        {
          id: "env_dev_base_url",
          key: "baseUrl",
          value: "https://jsonplaceholder.typicode.com",
          enabled: true,
        },
      ],
      createdAt: now,
      updatedAt: now,
    },
  ];
}

export function createSeedSnapshot(): AppSnapshot {
  const now = nowIso();
  const workspace = buildWorkspace(now);
  const collection = buildCollection(workspace.id, now);
  const requests = buildRequests(workspace.id, collection.id, now);

  return {
    version: 1,
    workspaces: [workspace],
    collections: [collection],
    collectionFolders: buildCollectionFolders(workspace.id, collection.id, now),
    requests,
    environments: buildEnvironments(workspace.id, now),
    history: [],
    selectedWorkspaceId: workspace.id,
    selectedCollectionId: collection.id,
    selectedRequestId: requests[0].id,
    selectedEnvironmentId: "env_dev",
    openRequestIds: [requests[0].id],
  };
}
