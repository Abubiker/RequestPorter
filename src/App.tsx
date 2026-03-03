import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useState, type MouseEvent } from "react";
import "./App.css";
import { SIDEBAR_SECTIONS } from "./domain/constants";
import type { AuthConfig, HttpMethod, KeyValue, SidebarSection } from "./domain/models";
import {
  getActiveRequest,
  getCollectionsForActiveWorkspace,
  getEnvironmentsForActiveWorkspace,
  getOpenRequests,
  getRequestsForActiveCollection,
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

function newKeyValue(prefix: "kv" | "header" | "query" = "kv"): KeyValue {
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
    return [...list, { id: newKeyValue("kv").id, key, value, enabled: true }];
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
  const selectRequest = useAppStore((state) => state.selectRequest);
  const closeRequestTab = useAppStore((state) => state.closeRequestTab);
  const createRequest = useAppStore((state) => state.createRequest);
  const updateSelectedRequest = useAppStore((state) => state.updateSelectedRequest);
  const recordHistory = useAppStore((state) => state.recordHistory);

  const [editorTab, setEditorTab] = useState<EditorTab>("params");
  const [responseTab, setResponseTab] = useState<ResponseTab>("pretty");
  const [runtimeResponse, setRuntimeResponse] = useState<RuntimeResponse | null>(null);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [isSending, setIsSending] = useState(false);
  const [isCurlOpen, setIsCurlOpen] = useState(false);
  const [curlValue, setCurlValue] = useState("");
  const [curlError, setCurlError] = useState<string | null>(null);

  useEffect(() => {
    void useAppStore.getState().load();
  }, []);

  const collections = getCollectionsForActiveWorkspace(data);
  const requests = getRequestsForActiveCollection(data);
  const openRequests = getOpenRequests(data);
  const activeRequest = getActiveRequest(data);
  const environments = getEnvironmentsForActiveWorkspace(data);
  const history = data.history
    .filter((entry) => entry.workspaceId === data.selectedWorkspaceId)
    .slice(0, 24);

  useEffect(() => {
    setRuntimeError(null);
    setRuntimeResponse(null);
  }, [data.selectedRequestId]);

  const responsePretty = useMemo(
    () => (runtimeResponse ? formatJson(runtimeResponse.body) : ""),
    [runtimeResponse],
  );

  const activeSectionMeta: Record<SidebarSection, string> = {
    Collections: `${requests.length} requests`,
    History: `${history.length} records`,
    Environments: `${environments.length} env`,
  };

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

  const updateAuth = (nextAuth: AuthConfig) => {
    updateSelectedRequest({ auth: normalizeAuth(nextAuth) });
  };

  const closeTab = (event: MouseEvent<HTMLElement>, requestId: string) => {
    event.stopPropagation();
    closeRequestTab(requestId);
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
      headers = upsertItem(headers, "Authorization", `Bearer ${auth.value}`);
    }

    if (auth.type === "apiKey" && auth.key && auth.value) {
      if (auth.in === "query") {
        queryParams = upsertItem(queryParams, auth.key, auth.value);
      } else {
        headers = upsertItem(headers, auth.key, auth.value);
      }
    }

    try {
      const response = await invoke<RuntimeResponse>("send_http_request", {
        payload: {
          method: activeRequest.method,
          url: activeRequest.url,
          headers,
          queryParams,
          body: activeRequest.body ?? "",
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
        url: activeRequest.url,
        statusCode: 0,
        durationMs: 0,
        responseSizeBytes: 0,
      });
    } finally {
      setIsSending(false);
    }
  };

  return (
    <main className="shell">
      <aside className="nav-rail motion-enter">
        <div className="brand-avatar">E</div>
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
          <ul className="request-list">
            {requests.map((request) => (
              <li key={request.id}>
                <button
                  type="button"
                  className={request.id === data.selectedRequestId ? "request-item active" : "request-item"}
                  onClick={() => selectRequest(request.id)}
                >
                  <span className={`method-badge ${getMethodColor(request.method)}`}>
                    {request.method}
                  </span>
                  <span className="request-title">{request.name}</span>
                </button>
              </li>
            ))}
          </ul>
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
            <p>Free desktop API client for team workflows</p>
          </div>
          <div className="top-actions">
            <button type="button" className="outline-btn" onClick={() => createRequest()}>
              + New Request
            </button>
            <button type="button" className="outline-btn" onClick={() => setIsCurlOpen(true)}>
              Import cURL
            </button>
            <span className="pill">{isSaving ? "Saving..." : "Saved"}</span>
            <span className="pill">Local-first</span>
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
                        placeholder="paste bearer token"
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
                          placeholder="api key value"
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
                ✕
              </button>
            </header>
            <textarea
              value={curlValue}
              onChange={(event) => setCurlValue(event.currentTarget.value)}
              placeholder='curl -X GET "https://jsonplaceholder.typicode.com/todos/1"'
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
    </main>
  );
}

export default App;
