import { invoke } from "@tauri-apps/api/core";
import {
  useEffect,
  useMemo,
  useState,
  type MouseEvent,
  type ReactElement,
} from "react";
import "./App.css";
import { SIDEBAR_SECTIONS } from "./domain/constants";
import type {
  AuthConfig,
  EnvironmentVariable,
  HttpMethod,
  KeyValue,
  SidebarSection,
} from "./domain/models";
import {
  getActiveRequest,
  getCollectionsForActiveWorkspace,
  getEnvironmentsForActiveWorkspace,
  getFoldersForActiveCollection,
  getGlobalHeadersForActiveWorkspace,
  getGlobalVariablesForActiveWorkspace,
  getOpenRequests,
  getRequestsForActiveCollection,
  getSelectedEnvironment,
  useAppStore,
} from "./state/appStore";
import { parseCurlCommand } from "./utils/curl";

type EditorTab = "params" | "headers" | "auth" | "body";
type ResponseTab = "pretty" | "raw" | "headers";

interface RuntimeHeader {
  key: string;
  value: string;
}

interface RuntimeResponse {
  statusCode: number;
  headers: RuntimeHeader[];
  body: string;
  durationMs: number;
  sizeBytes: number;
  url: string;
  ok: boolean;
}

type EditableRow = {
  id: string;
  key: string;
  value: string;
  enabled: boolean;
};

function bytesToReadable(size: number): string {
  if (size < 1024) {
    return `${size} B`;
  }

  return `${(size / 1024).toFixed(1)} KB`;
}

function formatJson(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

function toErrorMessage(error: unknown): string {
  if (typeof error === "string") {
    return error;
  }

  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") {
      return message;
    }
  }

  try {
    return JSON.stringify(error);
  } catch {
    return "Unknown request error";
  }
}

function getMethodColor(method: HttpMethod): string {
  switch (method) {
    case "GET":
      return "method-green";
    case "POST":
      return "method-orange";
    case "PUT":
    case "PATCH":
      return "method-blue";
    case "DELETE":
      return "method-red";
    case "HEAD":
    case "OPTIONS":
      return "method-gray";
    default:
      return "method-gray";
  }
}

function newKeyValue(prefix: "kv" | "header" | "query" | "var" = "kv"): KeyValue {
  return {
    id: `${prefix}_${Math.random().toString(36).slice(2, 10)}`,
    key: "",
    value: "",
    enabled: true,
  };
}

function upsertItem(list: KeyValue[], key: string, value: string): KeyValue[] {
  const normalizedKey = key.toLowerCase();
  const existingIndex = list.findIndex(
    (item) => item.enabled && item.key.toLowerCase() === normalizedKey,
  );

  if (existingIndex === -1) {
    return [...list, { ...newKeyValue("kv"), key, value }];
  }

  return list.map((item, index) =>
    index === existingIndex
      ? {
          ...item,
          value,
          enabled: true,
        }
      : item,
  );
}

function mergePairs(base: KeyValue[], additions: KeyValue[]): KeyValue[] {
  let next = [...base];
  additions.forEach((item) => {
    if (!item.enabled || !item.key.trim()) {
      return;
    }
    next = upsertItem(next, item.key, item.value);
  });
  return next;
}

function interpolateTemplate(input: string, variables: Record<string, string>): string {
  return input.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_, rawKey: string) => {
    const value = variables[rawKey];
    return value ?? `{{${rawKey}}}`;
  });
}

function buildVariablesMap(
  globalVariables: EnvironmentVariable[],
  environmentVariables: EnvironmentVariable[],
): Record<string, string> {
  const output: Record<string, string> = {};

  globalVariables.forEach((item) => {
    if (item.enabled && item.key.trim()) {
      output[item.key.trim()] = item.value;
    }
  });
  environmentVariables.forEach((item) => {
    if (item.enabled && item.key.trim()) {
      output[item.key.trim()] = item.value;
    }
  });

  return output;
}

function normalizeAuth(auth?: AuthConfig): AuthConfig {
  if (!auth) {
    return { type: "none" };
  }
  if (auth.type === "apiKey") {
    return {
      type: "apiKey",
      key: auth.key ?? "X-API-Key",
      value: auth.value ?? "",
      in: auth.in ?? "header",
    };
  }
  if (auth.type === "bearer") {
    return {
      type: "bearer",
      value: auth.value ?? "",
    };
  }

  return { type: "none" };
}

function App() {
  const isLoaded = useAppStore((state) => state.isLoaded);
  const isSaving = useAppStore((state) => state.isSaving);
  const errorMessage = useAppStore((state) => state.errorMessage);
  const activeSection = useAppStore((state) => state.activeSection);
  const data = useAppStore((state) => state.data);
  const setActiveSection = useAppStore((state) => state.setActiveSection);
  const selectWorkspace = useAppStore((state) => state.selectWorkspace);
  const selectCollection = useAppStore((state) => state.selectCollection);
  const selectEnvironment = useAppStore((state) => state.selectEnvironment);
  const selectRequest = useAppStore((state) => state.selectRequest);
  const closeRequestTab = useAppStore((state) => state.closeRequestTab);
  const createRequest = useAppStore((state) => state.createRequest);
  const createCollectionFolder = useAppStore((state) => state.createCollectionFolder);
  const toggleCollectionFolder = useAppStore((state) => state.toggleCollectionFolder);
  const updateSelectedRequest = useAppStore((state) => state.updateSelectedRequest);
  const updateWorkspaceGlobals = useAppStore((state) => state.updateWorkspaceGlobals);
  const recordHistory = useAppStore((state) => state.recordHistory);

  const [editorTab, setEditorTab] = useState<EditorTab>("params");
  const [responseTab, setResponseTab] = useState<ResponseTab>("pretty");
  const [runtimeResponse, setRuntimeResponse] = useState<RuntimeResponse | null>(null);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [isSending, setIsSending] = useState(false);
  const [isCurlOpen, setIsCurlOpen] = useState(false);
  const [curlValue, setCurlValue] = useState("");
  const [curlError, setCurlError] = useState<string | null>(null);
  const [selectedFolderId, setSelectedFolderId] = useState<string | undefined>(undefined);
  const [isGlobalsOpen, setIsGlobalsOpen] = useState(false);
  const [globalHeadersDraft, setGlobalHeadersDraft] = useState<KeyValue[]>([]);
  const [globalVariablesDraft, setGlobalVariablesDraft] = useState<EnvironmentVariable[]>([]);

  useEffect(() => {
    void useAppStore.getState().load();
  }, []);

  const collections = getCollectionsForActiveWorkspace(data);
  const folders = getFoldersForActiveCollection(data);
  const requests = getRequestsForActiveCollection(data);
  const openRequests = getOpenRequests(data);
  const activeRequest = getActiveRequest(data);
  const environments = getEnvironmentsForActiveWorkspace(data);
  const selectedEnvironment = getSelectedEnvironment(data);
  const globalHeaders = getGlobalHeadersForActiveWorkspace(data);
  const globalVariables = getGlobalVariablesForActiveWorkspace(data);
  const selectedFolder = folders.find((folder) => folder.id === selectedFolderId);
  const history = data.history
    .filter((entry) => entry.workspaceId === data.selectedWorkspaceId)
    .slice(0, 24);

  useEffect(() => {
    setRuntimeError(null);
    setRuntimeResponse(null);
  }, [data.selectedRequestId]);

  useEffect(() => {
    setSelectedFolderId(undefined);
  }, [data.selectedCollectionId]);

  useEffect(() => {
    if (isGlobalsOpen) {
      setGlobalHeadersDraft(globalHeaders.map((item) => ({ ...item })));
      setGlobalVariablesDraft(globalVariables.map((item) => ({ ...item })));
    }
  }, [isGlobalsOpen, globalHeaders, globalVariables]);

  const responsePretty = useMemo(
    () => (runtimeResponse ? formatJson(runtimeResponse.body) : ""),
    [runtimeResponse],
  );

  const activeSectionMeta: Record<SidebarSection, string> = {
    Collections: `${requests.length} requests`,
    History: `${history.length} records`,
    Environments: `${environments.length} env`,
  };

  const variablesMap = useMemo(
    () => buildVariablesMap(globalVariables, selectedEnvironment?.variables ?? []),
    [globalVariables, selectedEnvironment],
  );

  if (!isLoaded) {
    return (
      <main className="shell">
        <section className="loading-screen">Preparing RequestPorter workspace...</section>
      </main>
    );
  }

  const mutatePairs = (target: "headers" | "queryParams", nextPairs: KeyValue[]) => {
    if (target === "headers") {
      updateSelectedRequest({ headers: nextPairs });
      return;
    }

    updateSelectedRequest({ queryParams: nextPairs });
  };

  const updatePairField = (
    target: "headers" | "queryParams",
    index: number,
    field: "key" | "value" | "enabled",
    value: string | boolean,
  ) => {
    if (!activeRequest) {
      return;
    }

    const source = target === "headers" ? activeRequest.headers : activeRequest.queryParams;
    const nextPairs = source.map((item, currentIndex) => {
      if (currentIndex !== index) {
        return item;
      }

      return {
        ...item,
        [field]: value,
      };
    });
    mutatePairs(target, nextPairs);
  };

  const addPairRow = (target: "headers" | "queryParams") => {
    if (!activeRequest) {
      return;
    }

    const source = target === "headers" ? activeRequest.headers : activeRequest.queryParams;
    mutatePairs(target, [...source, newKeyValue(target === "headers" ? "header" : "query")]);
  };

  const removePairRow = (target: "headers" | "queryParams", index: number) => {
    if (!activeRequest) {
      return;
    }

    const source = target === "headers" ? activeRequest.headers : activeRequest.queryParams;
    mutatePairs(
      target,
      source.filter((_, currentIndex) => currentIndex !== index),
    );
  };

  const updateDraftRow = (
    rows: EditableRow[],
    setRows: (nextRows: EditableRow[]) => void,
    index: number,
    field: "key" | "value" | "enabled",
    value: string | boolean,
  ) => {
    setRows(
      rows.map((item, currentIndex) =>
        currentIndex === index
          ? {
              ...item,
              [field]: value,
            }
          : item,
      ),
    );
  };

  const removeDraftRow = (
    rows: EditableRow[],
    setRows: (nextRows: EditableRow[]) => void,
    index: number,
  ) => {
    setRows(rows.filter((_, currentIndex) => currentIndex !== index));
  };

  const sanitizeRows = <T extends EditableRow>(rows: T[]): T[] => {
    return rows
      .map((item) => ({
        ...item,
        key: item.key.trim(),
      }))
      .filter((item) => item.key.length > 0);
  };

  const saveGlobals = () => {
    updateWorkspaceGlobals({
      globalHeaders: sanitizeRows(globalHeadersDraft),
      globalVariables: sanitizeRows(globalVariablesDraft),
    });
    setIsGlobalsOpen(false);
  };

  const updateAuth = (nextAuth: AuthConfig) => {
    updateSelectedRequest({ auth: normalizeAuth(nextAuth) });
  };

  const closeTab = (event: MouseEvent<HTMLElement>, requestId: string) => {
    event.stopPropagation();
    closeRequestTab(requestId);
  };

  const createFolderPrompt = (parentFolderId?: string) => {
    const name = window.prompt("Folder name");
    if (!name || !name.trim()) {
      return;
    }

    createCollectionFolder({ name: name.trim(), parentFolderId });
  };

  const importCurl = () => {
    try {
      const parsed = parseCurlCommand(curlValue);
      createRequest({
        method: parsed.method,
        url: parsed.url,
        headers: parsed.headers,
        queryParams: parsed.queryParams,
        body: parsed.body,
        auth: parsed.auth,
        name: parsed.name,
        folderId: selectedFolderId,
      });
      setCurlError(null);
      setCurlValue("");
      setIsCurlOpen(false);
    } catch (error) {
      setCurlError(toErrorMessage(error));
    }
  };

  const sendRequest = async () => {
    if (!activeRequest || isSending) {
      return;
    }

    setRuntimeError(null);
    setIsSending(true);

    const auth = normalizeAuth(activeRequest.auth);
    let headers = [...activeRequest.headers];
    let queryParams = [...activeRequest.queryParams];

    if (auth.type === "bearer" && auth.value) {
      headers = upsertItem(headers, "Authorization", auth.value.startsWith("Bearer ") ? auth.value : `Bearer ${auth.value}`);
    }

    if (auth.type === "apiKey" && auth.key && auth.value) {
      if (auth.in === "query") {
        queryParams = upsertItem(queryParams, auth.key, auth.value);
      } else {
        headers = upsertItem(headers, auth.key, auth.value);
      }
    }

    headers = mergePairs(globalHeaders, headers);

    const resolvedUrl = interpolateTemplate(activeRequest.url, variablesMap);
    const resolvedBody = interpolateTemplate(activeRequest.body ?? "", variablesMap);
    const resolvedHeaders = headers
      .filter((item) => item.enabled && item.key.trim())
      .map((item) => ({
        ...item,
        key: interpolateTemplate(item.key, variablesMap),
        value: interpolateTemplate(item.value, variablesMap),
      }));
    const resolvedQuery = queryParams
      .filter((item) => item.enabled && item.key.trim())
      .map((item) => ({
        ...item,
        key: interpolateTemplate(item.key, variablesMap),
        value: interpolateTemplate(item.value, variablesMap),
      }));

    try {
      const response = await invoke<RuntimeResponse>("send_http_request", {
        payload: {
          method: activeRequest.method,
          url: resolvedUrl,
          headers: resolvedHeaders,
          queryParams: resolvedQuery,
          body: resolvedBody,
          timeoutMs: 30_000,
        },
      });

      setRuntimeResponse(response);
      recordHistory({
        requestId: activeRequest.id,
        method: activeRequest.method,
        url: response.url,
        statusCode: response.statusCode,
        durationMs: response.durationMs,
        responseSizeBytes: response.sizeBytes,
      });
    } catch (error) {
      const message = toErrorMessage(error);
      setRuntimeResponse(null);
      setRuntimeError(message);
      recordHistory({
        requestId: activeRequest.id,
        method: activeRequest.method,
        url: resolvedUrl,
        statusCode: 0,
        durationMs: 0,
        responseSizeBytes: 0,
      });
    } finally {
      setIsSending(false);
    }
  };

  const renderCollectionTree = (parentFolderId?: string, depth = 0): ReactElement[] => {
    const folderKey = parentFolderId ?? "__root";
    const childFolders = folders
      .filter((folder) => (folder.parentFolderId ?? "__root") === folderKey)
      .sort((a, b) => a.name.localeCompare(b.name));
    const directRequests = requests.filter(
      (request) => (request.folderId ?? "__root") === folderKey,
    );

    const nodes: ReactElement[] = [];

    childFolders.forEach((folder) => {
      const expanded = folder.expanded ?? true;
      nodes.push(
        <li key={folder.id} className="tree-node">
          <div
            className={selectedFolderId === folder.id ? "folder-row active" : "folder-row"}
            style={{ paddingLeft: `${10 + depth * 16}px` }}
          >
            <button
              type="button"
              className="folder-toggle"
              onClick={() => toggleCollectionFolder(folder.id)}
            >
              {expanded ? "▾" : "▸"}
            </button>
            <button
              type="button"
              className="folder-label"
              onClick={() => setSelectedFolderId(folder.id)}
            >
              {folder.name}
            </button>
            <div className="folder-actions">
              <button
                type="button"
                className="icon-btn-sm"
                onClick={() => createRequest({ folderId: folder.id })}
                title="Add request"
              >
                +
              </button>
              <button
                type="button"
                className="icon-btn-sm"
                onClick={() => createFolderPrompt(folder.id)}
                title="Add subfolder"
              >
                F+
              </button>
            </div>
          </div>
          {expanded ? <ul className="tree-children">{renderCollectionTree(folder.id, depth + 1)}</ul> : null}
        </li>,
      );
    });

    directRequests.forEach((request) => {
      nodes.push(
        <li key={request.id} className="tree-node">
          <button
            type="button"
            className={request.id === data.selectedRequestId ? "tree-request-item active" : "tree-request-item"}
            style={{ paddingLeft: `${26 + depth * 16}px` }}
            onClick={() => selectRequest(request.id)}
          >
            <span className={`method-badge ${getMethodColor(request.method)}`}>{request.method}</span>
            <span className="tree-request-title">{request.name}</span>
          </button>
        </li>,
      );
    });

    return nodes;
  };

  return (
    <main className="shell">
      <aside className="nav-rail motion-enter">
        <div className="brand-avatar">R</div>
        <div className="rail-actions">
          {SIDEBAR_SECTIONS.map((section) => (
            <button
              key={section}
              type="button"
              className={section === activeSection ? "rail-button active" : "rail-button"}
              onClick={() => setActiveSection(section)}
              title={section}
            >
              {section.slice(0, 1)}
            </button>
          ))}
        </div>
        <div className="rail-footer">macOS</div>
      </aside>

      <section className="catalog-pane motion-enter delay-1">
        <header className="catalog-header">
          <h1>APIs</h1>
          <p>Workspace collections</p>
        </header>

        <div className="selectors">
          <label>
            Workspace
            <select
              aria-label="Workspace selector"
              value={data.selectedWorkspaceId}
              onChange={(event) => selectWorkspace(event.currentTarget.value)}
            >
              {data.workspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.name}
                </option>
              ))}
            </select>
          </label>

          <label>
            Collection
            <select
              aria-label="Collection selector"
              value={data.selectedCollectionId}
              onChange={(event) => selectCollection(event.currentTarget.value)}
            >
              {collections.map((collection) => (
                <option key={collection.id} value={collection.id}>
                  {collection.name}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="catalog-meta">
          <span>{activeSection}</span>
          <span>{activeSectionMeta[activeSection]}</span>
        </div>

        {activeSection === "Collections" ? (
          <>
            <div className="catalog-actions">
              <button type="button" className="outline-btn" onClick={() => createRequest({ folderId: selectedFolderId })}>
                + Request
              </button>
              <button type="button" className="outline-btn" onClick={() => createFolderPrompt(selectedFolderId)}>
                + Folder
              </button>
            </div>
            {selectedFolderId ? (
              <p className="selected-folder-pill">
                Folder selected: {selectedFolder?.name ?? "unknown"}
              </p>
            ) : (
              <p className="selected-folder-pill">Folder selected: root</p>
            )}
            <ul className="tree-root">{renderCollectionTree(undefined, 0)}</ul>
          </>
        ) : null}

        {activeSection === "History" ? (
          <ul className="history-compact">
            {history.length ? (
              history.map((entry) => (
                <li key={entry.id} className="history-compact-item">
                  <span className={`method-badge ${getMethodColor(entry.method)}`}>
                    {entry.method}
                  </span>
                  <div>
                    <p>{entry.url}</p>
                    <small>
                      {entry.statusCode || "ERR"} · {entry.durationMs} ms ·{" "}
                      {bytesToReadable(entry.responseSizeBytes)}
                    </small>
                  </div>
                </li>
              ))
            ) : (
              <li className="hint">No history yet. Run your first request.</li>
            )}
          </ul>
        ) : null}

        {activeSection === "Environments" ? (
          <ul className="env-compact">
            {environments.length ? (
              environments.map((env) => (
                <li key={env.id} className="env-compact-item">
                  <h4>{env.name}</h4>
                  <p>{env.variables.length} variables</p>
                </li>
              ))
            ) : (
              <li className="hint">No environments found.</li>
            )}
          </ul>
        ) : null}
      </section>

      <section className="main-pane motion-enter delay-2">
        <header className="top-bar">
          <div>
            <h2>{activeRequest ? activeRequest.name : "No request selected"}</h2>
            <p>RequestPorter · folders, globals and real requests</p>
          </div>
          <div className="top-actions">
            <label className="env-select">
              Environment
              <select
                value={data.selectedEnvironmentId ?? ""}
                onChange={(event) => selectEnvironment(event.currentTarget.value)}
              >
                {environments.map((environment) => (
                  <option key={environment.id} value={environment.id}>
                    {environment.name}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" className="outline-btn" onClick={() => setIsGlobalsOpen(true)}>
              Globals
            </button>
            <button type="button" className="outline-btn" onClick={() => setIsCurlOpen(true)}>
              Import cURL
            </button>
            <span className="pill">{isSaving ? "Saving..." : "Saved"}</span>
            <span className="pill">{selectedEnvironment?.name ?? "no env"}</span>
          </div>
        </header>

        {errorMessage ? <p className="error-banner">{errorMessage}</p> : null}

        {activeRequest ? (
          <>
            <div className="request-tabs">
              {openRequests.map((request) => (
                <button
                  key={request.id}
                  type="button"
                  className={request.id === data.selectedRequestId ? "request-tab active" : "request-tab"}
                  onClick={() => selectRequest(request.id)}
                >
                  <span className={`method-badge ${getMethodColor(request.method)}`}>
                    {request.method}
                  </span>
                  <span>{request.name}</span>
                  <span className="request-tab-close" onClick={(event) => closeTab(event, request.id)}>
                    ×
                  </span>
                </button>
              ))}
            </div>

            <section className="request-card">
              <div className="request-compose">
                <select
                  className={getMethodColor(activeRequest.method)}
                  aria-label="HTTP method"
                  value={activeRequest.method}
                  onChange={(event) =>
                    updateSelectedRequest({ method: event.currentTarget.value as HttpMethod })
                  }
                >
                  <option>GET</option>
                  <option>POST</option>
                  <option>PUT</option>
                  <option>PATCH</option>
                  <option>DELETE</option>
                  <option>HEAD</option>
                  <option>OPTIONS</option>
                </select>
                <input
                  aria-label="Request URL"
                  value={activeRequest.url}
                  onChange={(event) => updateSelectedRequest({ url: event.currentTarget.value })}
                />
                <button
                  type="button"
                  className={isSending ? "send-button sending" : "send-button"}
                  onClick={sendRequest}
                  disabled={isSending}
                >
                  {isSending ? "Sending..." : "Send"}
                </button>
              </div>

              <div className="editor-tabs">
                <button
                  type="button"
                  className={editorTab === "params" ? "editor-tab active" : "editor-tab"}
                  onClick={() => setEditorTab("params")}
                >
                  Params
                </button>
                <button
                  type="button"
                  className={editorTab === "headers" ? "editor-tab active" : "editor-tab"}
                  onClick={() => setEditorTab("headers")}
                >
                  Headers
                </button>
                <button
                  type="button"
                  className={editorTab === "auth" ? "editor-tab active" : "editor-tab"}
                  onClick={() => setEditorTab("auth")}
                >
                  Auth
                </button>
                <button
                  type="button"
                  className={editorTab === "body" ? "editor-tab active" : "editor-tab"}
                  onClick={() => setEditorTab("body")}
                >
                  Body
                </button>
              </div>

              {editorTab === "params" ? (
                <div className="table-editor">
                  <div className="table-head">
                    <span>On</span>
                    <span>Parameter</span>
                    <span>Value</span>
                    <span />
                  </div>
                  {activeRequest.queryParams.map((item, index) => (
                    <div key={item.id} className="table-row">
                      <input
                        type="checkbox"
                        checked={item.enabled}
                        onChange={(event) =>
                          updatePairField(
                            "queryParams",
                            index,
                            "enabled",
                            event.currentTarget.checked,
                          )
                        }
                      />
                      <input
                        value={item.key}
                        placeholder="key"
                        onChange={(event) =>
                          updatePairField("queryParams", index, "key", event.currentTarget.value)
                        }
                      />
                      <input
                        value={item.value}
                        placeholder="value"
                        onChange={(event) =>
                          updatePairField("queryParams", index, "value", event.currentTarget.value)
                        }
                      />
                      <button type="button" onClick={() => removePairRow("queryParams", index)}>
                        Remove
                      </button>
                    </div>
                  ))}
                  <button type="button" className="small-action" onClick={() => addPairRow("queryParams")}>
                    + Add Param
                  </button>
                </div>
              ) : null}

              {editorTab === "headers" ? (
                <div className="table-editor">
                  <div className="table-head">
                    <span>On</span>
                    <span>Header</span>
                    <span>Value</span>
                    <span />
                  </div>
                  {activeRequest.headers.map((item, index) => (
                    <div key={item.id} className="table-row">
                      <input
                        type="checkbox"
                        checked={item.enabled}
                        onChange={(event) =>
                          updatePairField("headers", index, "enabled", event.currentTarget.checked)
                        }
                      />
                      <input
                        value={item.key}
                        placeholder="header"
                        onChange={(event) =>
                          updatePairField("headers", index, "key", event.currentTarget.value)
                        }
                      />
                      <input
                        value={item.value}
                        placeholder="value"
                        onChange={(event) =>
                          updatePairField("headers", index, "value", event.currentTarget.value)
                        }
                      />
                      <button type="button" onClick={() => removePairRow("headers", index)}>
                        Remove
                      </button>
                    </div>
                  ))}
                  <button type="button" className="small-action" onClick={() => addPairRow("headers")}>
                    + Add Header
                  </button>
                </div>
              ) : null}

              {editorTab === "auth" ? (
                <div className="auth-editor">
                  <label>
                    Type
                    <select
                      value={normalizeAuth(activeRequest.auth).type}
                      onChange={(event) => {
                        const nextType = event.currentTarget.value as AuthConfig["type"];
                        if (nextType === "bearer") {
                          updateAuth({ type: "bearer", value: "" });
                          return;
                        }
                        if (nextType === "apiKey") {
                          updateAuth({
                            type: "apiKey",
                            key: "X-API-Key",
                            value: "",
                            in: "header",
                          });
                          return;
                        }

                        updateAuth({ type: "none" });
                      }}
                    >
                      <option value="none">None</option>
                      <option value="bearer">Bearer Token</option>
                      <option value="apiKey">API Key</option>
                    </select>
                  </label>

                  {normalizeAuth(activeRequest.auth).type === "bearer" ? (
                    <label>
                      Token
                      <input
                        value={normalizeAuth(activeRequest.auth).value ?? ""}
                        onChange={(event) =>
                          updateAuth({
                            type: "bearer",
                            value: event.currentTarget.value,
                          })
                        }
                        placeholder="{{authToken}}"
                      />
                    </label>
                  ) : null}

                  {normalizeAuth(activeRequest.auth).type === "apiKey" ? (
                    <div className="auth-grid">
                      <label>
                        Key
                        <input
                          value={normalizeAuth(activeRequest.auth).key ?? ""}
                          onChange={(event) =>
                            updateAuth({
                              type: "apiKey",
                              key: event.currentTarget.value,
                              value: normalizeAuth(activeRequest.auth).value ?? "",
                              in: normalizeAuth(activeRequest.auth).in ?? "header",
                            })
                          }
                          placeholder="X-API-Key"
                        />
                      </label>
                      <label>
                        Value
                        <input
                          value={normalizeAuth(activeRequest.auth).value ?? ""}
                          onChange={(event) =>
                            updateAuth({
                              type: "apiKey",
                              key: normalizeAuth(activeRequest.auth).key ?? "X-API-Key",
                              value: event.currentTarget.value,
                              in: normalizeAuth(activeRequest.auth).in ?? "header",
                            })
                          }
                          placeholder="{{apiKey}}"
                        />
                      </label>
                      <label>
                        Add to
                        <select
                          value={normalizeAuth(activeRequest.auth).in ?? "header"}
                          onChange={(event) =>
                            updateAuth({
                              type: "apiKey",
                              key: normalizeAuth(activeRequest.auth).key ?? "X-API-Key",
                              value: normalizeAuth(activeRequest.auth).value ?? "",
                              in: event.currentTarget.value as "header" | "query",
                            })
                          }
                        >
                          <option value="header">Header</option>
                          <option value="query">Query Param</option>
                        </select>
                      </label>
                    </div>
                  ) : null}
                </div>
              ) : null}

              {editorTab === "body" ? (
                <textarea
                  className="body-editor"
                  value={activeRequest.body ?? ""}
                  placeholder='{"key":"value"}'
                  onChange={(event) => updateSelectedRequest({ body: event.currentTarget.value })}
                />
              ) : null}
            </section>

            <section className="response-card">
              <header className="response-header">
                <div className="editor-tabs">
                  <button
                    type="button"
                    className={responseTab === "pretty" ? "editor-tab active" : "editor-tab"}
                    onClick={() => setResponseTab("pretty")}
                  >
                    Pretty
                  </button>
                  <button
                    type="button"
                    className={responseTab === "raw" ? "editor-tab active" : "editor-tab"}
                    onClick={() => setResponseTab("raw")}
                  >
                    Raw
                  </button>
                  <button
                    type="button"
                    className={responseTab === "headers" ? "editor-tab active" : "editor-tab"}
                    onClick={() => setResponseTab("headers")}
                  >
                    Headers
                  </button>
                </div>

                <div className="response-metrics">
                  <span className="pill">Status: {runtimeResponse?.statusCode ?? "-"}</span>
                  <span className="pill">Time: {runtimeResponse?.durationMs ?? 0} ms</span>
                  <span className="pill">
                    Size: {bytesToReadable(runtimeResponse?.sizeBytes ?? 0)}
                  </span>
                </div>
              </header>

              {runtimeError ? <p className="request-error">{runtimeError}</p> : null}

              {!runtimeResponse && !runtimeError ? (
                <p className="hint">Send a request to see live response data.</p>
              ) : null}

              {runtimeResponse && responseTab === "pretty" ? (
                <pre className="response-viewer animate-in">{responsePretty}</pre>
              ) : null}

              {runtimeResponse && responseTab === "raw" ? (
                <pre className="response-viewer animate-in">{runtimeResponse.body}</pre>
              ) : null}

              {runtimeResponse && responseTab === "headers" ? (
                <ul className="headers-list animate-in">
                  {runtimeResponse.headers.map((header) => (
                    <li key={`${header.key}:${header.value}`}>
                      <strong>{header.key}</strong>
                      <span>{header.value}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </section>
          </>
        ) : (
          <section className="request-card">
            <p className="hint">Select a request from the left catalog.</p>
          </section>
        )}
      </section>

      {isCurlOpen ? (
        <div className="curl-modal-backdrop">
          <div className="curl-modal">
            <header>
              <h3>Import cURL</h3>
              <button type="button" onClick={() => setIsCurlOpen(false)}>
                x
              </button>
            </header>
            <textarea
              value={curlValue}
              onChange={(event) => setCurlValue(event.currentTarget.value)}
              placeholder='curl -X GET "{{baseUrl}}/todos/1"'
            />
            {curlError ? <p className="request-error">{curlError}</p> : null}
            <footer>
              <button type="button" className="outline-btn" onClick={() => setIsCurlOpen(false)}>
                Cancel
              </button>
              <button type="button" className="send-button" onClick={importCurl}>
                Import
              </button>
            </footer>
          </div>
        </div>
      ) : null}

      {isGlobalsOpen ? (
        <div className="curl-modal-backdrop">
          <div className="curl-modal globals-modal">
            <header>
              <h3>Global Variables & Headers</h3>
              <button type="button" onClick={() => setIsGlobalsOpen(false)}>
                x
              </button>
            </header>

            <div className="globals-grid">
              <section className="table-editor">
                <h4>Global Variables</h4>
                <div className="table-head">
                  <span>On</span>
                  <span>Variable</span>
                  <span>Value</span>
                  <span />
                </div>
                {globalVariablesDraft.map((item, index) => (
                  <div key={item.id} className="table-row">
                    <input
                      type="checkbox"
                      checked={item.enabled}
                      onChange={(event) =>
                        updateDraftRow(
                          globalVariablesDraft,
                          (next) => setGlobalVariablesDraft(next as EnvironmentVariable[]),
                          index,
                          "enabled",
                          event.currentTarget.checked,
                        )
                      }
                    />
                    <input
                      value={item.key}
                      onChange={(event) =>
                        updateDraftRow(
                          globalVariablesDraft,
                          (next) => setGlobalVariablesDraft(next as EnvironmentVariable[]),
                          index,
                          "key",
                          event.currentTarget.value,
                        )
                      }
                      placeholder="baseUrl"
                    />
                    <input
                      value={item.value}
                      onChange={(event) =>
                        updateDraftRow(
                          globalVariablesDraft,
                          (next) => setGlobalVariablesDraft(next as EnvironmentVariable[]),
                          index,
                          "value",
                          event.currentTarget.value,
                        )
                      }
                      placeholder="https://api.example.com"
                    />
                    <button
                      type="button"
                      onClick={() =>
                        removeDraftRow(
                          globalVariablesDraft,
                          (next) => setGlobalVariablesDraft(next as EnvironmentVariable[]),
                          index,
                        )
                      }
                    >
                      Remove
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  className="small-action"
                  onClick={() => setGlobalVariablesDraft([...globalVariablesDraft, { ...newKeyValue("var") }])}
                >
                  + Add Variable
                </button>
              </section>

              <section className="table-editor">
                <h4>Global Headers</h4>
                <div className="table-head">
                  <span>On</span>
                  <span>Header</span>
                  <span>Value</span>
                  <span />
                </div>
                {globalHeadersDraft.map((item, index) => (
                  <div key={item.id} className="table-row">
                    <input
                      type="checkbox"
                      checked={item.enabled}
                      onChange={(event) =>
                        updateDraftRow(
                          globalHeadersDraft,
                          (next) => setGlobalHeadersDraft(next as KeyValue[]),
                          index,
                          "enabled",
                          event.currentTarget.checked,
                        )
                      }
                    />
                    <input
                      value={item.key}
                      onChange={(event) =>
                        updateDraftRow(
                          globalHeadersDraft,
                          (next) => setGlobalHeadersDraft(next as KeyValue[]),
                          index,
                          "key",
                          event.currentTarget.value,
                        )
                      }
                      placeholder="X-Request-Source"
                    />
                    <input
                      value={item.value}
                      onChange={(event) =>
                        updateDraftRow(
                          globalHeadersDraft,
                          (next) => setGlobalHeadersDraft(next as KeyValue[]),
                          index,
                          "value",
                          event.currentTarget.value,
                        )
                      }
                      placeholder="RequestPorter"
                    />
                    <button
                      type="button"
                      onClick={() =>
                        removeDraftRow(
                          globalHeadersDraft,
                          (next) => setGlobalHeadersDraft(next as KeyValue[]),
                          index,
                        )
                      }
                    >
                      Remove
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  className="small-action"
                  onClick={() => setGlobalHeadersDraft([...globalHeadersDraft, newKeyValue("header")])}
                >
                  + Add Header
                </button>
              </section>
            </div>

            <footer>
              <button type="button" className="outline-btn" onClick={() => setIsGlobalsOpen(false)}>
                Cancel
              </button>
              <button type="button" className="send-button" onClick={saveGlobals}>
                Save Globals
              </button>
            </footer>
          </div>
        </div>
      ) : null}
    </main>
  );
}

export default App;
