import type {
  AppSnapshot,
  Collection,
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

function buildRequests(workspaceId: string, collectionId: string, now: string): ApiRequest[] {
  return [
    {
      id: "req_health",
      workspaceId,
      collectionId,
      name: "GET /todos/1",
      method: "GET",
      url: "https://jsonplaceholder.typicode.com/todos/1",
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
      name: "POST /posts",
      method: "POST",
      url: "https://jsonplaceholder.typicode.com/posts",
      headers: [
        {
          id: "header_content_type",
          key: "Content-Type",
          value: "application/json",
          enabled: true,
        },
      ],
      queryParams: [],
      auth: { type: "none" },
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
    requests,
    environments: buildEnvironments(workspace.id, now),
    history: [],
    selectedWorkspaceId: workspace.id,
    selectedCollectionId: collection.id,
    selectedRequestId: requests[0].id,
    openRequestIds: [requests[0].id],
  };
}
