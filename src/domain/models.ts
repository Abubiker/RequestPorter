export type WorkspaceType = "personal" | "team";
export type WorkspaceRole = "owner" | "edit" | "view";
export type HttpMethod =
  | "GET"
  | "POST"
  | "PUT"
  | "DELETE"
  | "PATCH"
  | "HEAD"
  | "OPTIONS";
export type AuthType = "none" | "basic" | "bearer" | "apiKey" | "oauth2";
export type SidebarSection = "Collections" | "History" | "Environments";

export interface WorkspaceMember {
  id: string;
  name: string;
  email: string;
  role: WorkspaceRole;
}

export interface Workspace {
  id: string;
  name: string;
  type: WorkspaceType;
  members: WorkspaceMember[];
  createdAt: string;
  updatedAt: string;
}

export interface KeyValue {
  id: string;
  key: string;
  value: string;
  enabled: boolean;
}

export interface AuthConfig {
  type: AuthType;
  key?: string;
  value?: string;
  in?: "header" | "query";
}

export interface ApiRequest {
  id: string;
  workspaceId: string;
  collectionId: string;
  name: string;
  method: HttpMethod;
  url: string;
  headers: KeyValue[];
  queryParams: KeyValue[];
  auth: AuthConfig;
  body?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Collection {
  id: string;
  workspaceId: string;
  name: string;
  requestIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface EnvironmentVariable {
  id: string;
  key: string;
  value: string;
  enabled: boolean;
}

export interface Environment {
  id: string;
  workspaceId: string;
  name: string;
  variables: EnvironmentVariable[];
  createdAt: string;
  updatedAt: string;
}

export interface HistoryEntry {
  id: string;
  workspaceId: string;
  requestId: string;
  method: HttpMethod;
  url: string;
  statusCode: number;
  durationMs: number;
  responseSizeBytes: number;
  timestamp: string;
}

export interface LatestResponseSummary {
  statusCode: number;
  durationMs: number;
  responseSizeBytes: number;
  timestamp: string;
}

export interface AppSnapshot {
  version: 1;
  workspaces: Workspace[];
  collections: Collection[];
  requests: ApiRequest[];
  environments: Environment[];
  history: HistoryEntry[];
  selectedWorkspaceId: string;
  selectedCollectionId: string;
  selectedRequestId: string;
  openRequestIds?: string[];
}
