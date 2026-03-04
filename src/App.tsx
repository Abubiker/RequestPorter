import { invoke } from "@tauri-apps/api/core";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type MouseEvent,
  type ReactElement,
} from "react";
import "./App.css";
import { SIDEBAR_SECTIONS } from "./domain/constants";
import type {
  AuthConfig,
  CollectionFolder,
  EnvironmentVariable,
  HttpMethod,
  KeyValue,
  SidebarSection,
} from "./domain/models";
import {
  getActiveCollection,
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

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

interface JsonViewerLine {
  id: string;
  depth: number;
  content: ReactElement;
}

interface BuildJsonLinesParams {
  value: JsonValue;
  path: string;
  depth: number;
  isLast: boolean;
  keyName?: string;
  collapsedPaths: Set<string>;
  onToggle: (path: string) => void;
}

type EditableRow = {
  id: string;
  key: string;
  value: string;
  enabled: boolean;
};

type FolderDialogState =
  | {
      mode: "create";
      parentFolderId?: string;
    }
  | {
      mode: "rename";
      folderId: string;
    };

type DragItem =
  | {
      type: "request";
      id: string;
    }
  | {
      type: "folder";
      id: string;
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

function getHeaderValue(headers: RuntimeHeader[], name: string): string | undefined {
  const normalized = name.toLowerCase();
  const match = headers.find((item) => item.key.toLowerCase() === normalized);
  return match?.value;
}

function isLikelyJson(contentType: string, body: string): boolean {
  if (contentType.includes("application/json") || contentType.includes("+json")) {
    return true;
  }

  const trimmed = body.trim();
  return (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  );
}

function isLikelyMarkup(contentType: string, body: string): boolean {
  if (
    contentType.includes("text/html") ||
    contentType.includes("application/xml") ||
    contentType.includes("text/xml") ||
    contentType.includes("application/xhtml+xml")
  ) {
    return true;
  }

  const trimmed = body.trim();
  return trimmed.startsWith("<") && trimmed.endsWith(">");
}

function isSelfClosingTag(token: string): boolean {
  const raw = token.toLowerCase();
  return (
    raw.endsWith("/>") ||
    raw.startsWith("<!doctype") ||
    raw.startsWith("<?") ||
    raw.startsWith("<!") ||
    raw.startsWith("<br") ||
    raw.startsWith("<hr") ||
    raw.startsWith("<img") ||
    raw.startsWith("<meta") ||
    raw.startsWith("<link") ||
    raw.startsWith("<input")
  );
}

function formatMarkup(value: string): string {
  const collapsed = value.replace(/>\s+</g, "><").trim();
  if (!collapsed) {
    return value;
  }

  const tokens = collapsed
    .replace(/</g, "\n<")
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean);

  const lines: string[] = [];
  let level = 0;

  tokens.forEach((token) => {
    const isClosingTag = /^<\/[^>]+>$/i.test(token);
    const hasInlineClose = /^<[^/!][^>]*>.*<\/[^>]+>$/i.test(token);
    const isOpeningTag = /^<[^/!][^>]*>$/i.test(token) && !isSelfClosingTag(token);

    if (isClosingTag) {
      level = Math.max(level - 1, 0);
    }

    lines.push(`${"  ".repeat(level)}${token}`);

    if (!hasInlineClose && isOpeningTag) {
      level += 1;
    }
  });

  return lines.join("\n");
}

function formatPrettyBody(response: RuntimeResponse): string {
  const body = response.body ?? "";
  const contentType = (getHeaderValue(response.headers, "content-type") ?? "").toLowerCase();

  if (isLikelyJson(contentType, body)) {
    return formatJson(body);
  }

  if (isLikelyMarkup(contentType, body)) {
    return formatMarkup(body);
  }

  return body;
}

function isJsonRecord(value: JsonValue): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatJsonItemsLabel(
  value: JsonValue[] | { [key: string]: JsonValue },
): string {
  const count = Array.isArray(value) ? value.length : Object.keys(value).length;
  return `${count} item${count === 1 ? "" : "s"}`;
}

function tryParseResponseJson(response: RuntimeResponse): JsonValue | undefined {
  const body = response.body ?? "";
  const contentType = (getHeaderValue(response.headers, "content-type") ?? "").toLowerCase();

  if (!isLikelyJson(contentType, body)) {
    return undefined;
  }

  try {
    return JSON.parse(body) as JsonValue;
  } catch {
    return undefined;
  }
}

function renderJsonPrimitive(value: JsonValue): ReactElement {
  if (typeof value === "string") {
    return <span className="json-string">{JSON.stringify(value)}</span>;
  }
  if (typeof value === "number") {
    return <span className="json-number">{value}</span>;
  }
  if (typeof value === "boolean") {
    return <span className="json-boolean">{value ? "true" : "false"}</span>;
  }

  return <span className="json-null">null</span>;
}

function buildJsonViewerLines({
  value,
  path,
  depth,
  isLast,
  keyName,
  collapsedPaths,
  onToggle,
}: BuildJsonLinesParams): JsonViewerLine[] {
  const keyFragment = keyName ? (
    <>
      <span className="json-key">{JSON.stringify(keyName)}</span>
      <span className="json-punc">: </span>
    </>
  ) : null;

  const commaFragment = !isLast ? <span className="json-punc">,</span> : null;

  if (Array.isArray(value) || isJsonRecord(value)) {
    const isArray = Array.isArray(value);
    const openSymbol = isArray ? "[" : "{";
    const closeSymbol = isArray ? "]" : "}";
    const entries: Array<[string, JsonValue]> = isArray
      ? value.map((item, index) => [String(index), item])
      : Object.entries(value);

    if (entries.length === 0) {
      return [
        {
          id: `${path}:empty`,
          depth,
          content: (
            <span className="json-token-row">
              <span className="json-toggle-spacer" />
              {keyFragment}
              <span className="json-punc">
                {openSymbol}
                {closeSymbol}
              </span>
              {commaFragment}
            </span>
          ),
        },
      ];
    }

    const isCollapsed = collapsedPaths.has(path);
    const countLabel = formatJsonItemsLabel(value);

    if (isCollapsed) {
      return [
        {
          id: `${path}:collapsed`,
          depth,
          content: (
            <span className="json-token-row">
              <button type="button" className="json-toggle" onClick={() => onToggle(path)}>
                ▸
              </button>
              {keyFragment}
              <span className="json-punc">
                {openSymbol}
                ...
                {closeSymbol}
              </span>
              <span className="json-muted">{countLabel}</span>
              {commaFragment}
            </span>
          ),
        },
      ];
    }

    const lines: JsonViewerLine[] = [
      {
        id: `${path}:open`,
        depth,
        content: (
          <span className="json-token-row">
            <button type="button" className="json-toggle" onClick={() => onToggle(path)}>
              ▾
            </button>
            {keyFragment}
            <span className="json-punc">{openSymbol}</span>
          </span>
        ),
      },
    ];

    entries.forEach(([entryKey, entryValue], index) => {
      const childPath = isArray
        ? `${path}[${entryKey}]`
        : `${path}.${encodeURIComponent(entryKey)}`;
      lines.push(
        ...buildJsonViewerLines({
          value: entryValue,
          path: childPath,
          depth: depth + 1,
          isLast: index === entries.length - 1,
          keyName: isArray ? undefined : entryKey,
          collapsedPaths,
          onToggle,
        }),
      );
    });

    lines.push({
      id: `${path}:close`,
      depth,
      content: (
        <span className="json-token-row">
          <span className="json-toggle-spacer" />
          <span className="json-punc">{closeSymbol}</span>
          {commaFragment}
        </span>
      ),
    });

    return lines;
  }

  return [
    {
      id: `${path}:value`,
      depth,
      content: (
        <span className="json-token-row">
          <span className="json-toggle-spacer" />
          {keyFragment}
          {renderJsonPrimitive(value)}
          {commaFragment}
        </span>
      ),
    },
  ];
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

function getSidebarIcon(section: SidebarSection): ReactElement {
  if (section === "Collections") {
    return (
      <svg className="rail-icon" viewBox="0 0 24 24" aria-hidden="true">
        <path
          d="M4.5 6.5h15m-15 5.5h15m-15 5.5h9"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
      </svg>
    );
  }

  if (section === "History") {
    return (
      <svg className="rail-icon" viewBox="0 0 24 24" aria-hidden="true">
        <path
          d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3M4.5 4.8v4.1h4.1M12 8.5v4l2.7 1.6"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  return (
    <svg className="rail-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M5 7.5h14M5 12h14M5 16.5h9"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <circle cx="17.5" cy="16.5" r="2.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
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
  const renameCollection = useAppStore((state) => state.renameCollection);
  const duplicateCollection = useAppStore((state) => state.duplicateCollection);
  const deleteCollection = useAppStore((state) => state.deleteCollection);
  const createRequest = useAppStore((state) => state.createRequest);
  const createCollectionFolder = useAppStore((state) => state.createCollectionFolder);
  const renameCollectionFolder = useAppStore((state) => state.renameCollectionFolder);
  const deleteCollectionFolder = useAppStore((state) => state.deleteCollectionFolder);
  const duplicateCollectionFolder = useAppStore((state) => state.duplicateCollectionFolder);
  const toggleCollectionFolder = useAppStore((state) => state.toggleCollectionFolder);
  const moveCollectionFolder = useAppStore((state) => state.moveCollectionFolder);
  const moveRequestToFolder = useAppStore((state) => state.moveRequestToFolder);
  const moveRequestsToFolder = useAppStore((state) => state.moveRequestsToFolder);
  const deleteRequest = useAppStore((state) => state.deleteRequest);
  const deleteRequests = useAppStore((state) => state.deleteRequests);
  const duplicateRequest = useAppStore((state) => state.duplicateRequest);
  const duplicateRequests = useAppStore((state) => state.duplicateRequests);
  const updateSelectedRequest = useAppStore((state) => state.updateSelectedRequest);
  const updateWorkspaceGlobals = useAppStore((state) => state.updateWorkspaceGlobals);
  const recordHistory = useAppStore((state) => state.recordHistory);

  const [editorTab, setEditorTab] = useState<EditorTab>("params");
  const [responseTab, setResponseTab] = useState<ResponseTab>("pretty");
  const [runtimeResponse, setRuntimeResponse] = useState<RuntimeResponse | null>(null);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [collapsedJsonPaths, setCollapsedJsonPaths] = useState<Set<string>>(new Set());
  const [isSending, setIsSending] = useState(false);
  const [isCurlOpen, setIsCurlOpen] = useState(false);
  const [curlValue, setCurlValue] = useState("");
  const [curlError, setCurlError] = useState<string | null>(null);
  const [selectedFolderId, setSelectedFolderId] = useState<string | undefined>(undefined);
  const [isGlobalsOpen, setIsGlobalsOpen] = useState(false);
  const [globalHeadersDraft, setGlobalHeadersDraft] = useState<KeyValue[]>([]);
  const [globalVariablesDraft, setGlobalVariablesDraft] = useState<EnvironmentVariable[]>([]);
  const [folderDialog, setFolderDialog] = useState<FolderDialogState | null>(null);
  const [folderNameDraft, setFolderNameDraft] = useState("");
  const [isMoveRequestOpen, setIsMoveRequestOpen] = useState(false);
  const [movingRequestId, setMovingRequestId] = useState<string | null>(null);
  const [movingFolderDraft, setMovingFolderDraft] = useState("__root");
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [dragItem, setDragItem] = useState<DragItem | null>(null);
  const [dragOverTarget, setDragOverTarget] = useState<string | null>(null);
  const [selectedRequestIds, setSelectedRequestIds] = useState<string[]>([]);
  const [isCollectionMenuOpen, setIsCollectionMenuOpen] = useState(false);
  const [isCollectionRenameOpen, setIsCollectionRenameOpen] = useState(false);
  const [collectionNameDraft, setCollectionNameDraft] = useState("");
  const [isBulkMoveOpen, setIsBulkMoveOpen] = useState(false);
  const [bulkMoveFolderDraft, setBulkMoveFolderDraft] = useState("__root");
  const [collectionSearch, setCollectionSearch] = useState("");
  const [historyFocusRequestId, setHistoryFocusRequestId] = useState<string | null>(null);
  const collectionMenuRef = useRef<HTMLDivElement | null>(null);
  const [folderMenuId, setFolderMenuId] = useState<string | null>(null);
  const [requestMenuId, setRequestMenuId] = useState<string | null>(null);

  useEffect(() => {
    void useAppStore.getState().load();
  }, []);

  const collections = getCollectionsForActiveWorkspace(data);
  const activeCollection = getActiveCollection(data);
  const folders = getFoldersForActiveCollection(data);
  const requests = getRequestsForActiveCollection(data);
  const openRequests = getOpenRequests(data);
  const activeRequest = getActiveRequest(data);
  const environments = getEnvironmentsForActiveWorkspace(data);
  const selectedEnvironment = getSelectedEnvironment(data);
  const globalHeaders = getGlobalHeadersForActiveWorkspace(data);
  const globalVariables = getGlobalVariablesForActiveWorkspace(data);
  const folderById = useMemo(
    () => new Map(folders.map((folder) => [folder.id, folder] as const)),
    [folders],
  );
  const selectedFolder = folders.find((folder) => folder.id === selectedFolderId);
  const movingRequest = requests.find((request) => request.id === movingRequestId);
  const selectedRequests = requests.filter((request) =>
    selectedRequestIds.includes(request.id),
  );
  const requestsById = useMemo(
    () => new Map(data.requests.map((request) => [request.id, request] as const)),
    [data.requests],
  );
  const workspaceHistory = useMemo(
    () => data.history.filter((entry) => entry.workspaceId === data.selectedWorkspaceId),
    [data.history, data.selectedWorkspaceId],
  );
  const history = useMemo(() => {
    const scoped = historyFocusRequestId
      ? workspaceHistory.filter((entry) => entry.requestId === historyFocusRequestId)
      : workspaceHistory;

    return scoped.slice(0, 180);
  }, [workspaceHistory, historyFocusRequestId]);
  const historyFocusedRequest = historyFocusRequestId
    ? requestsById.get(historyFocusRequestId)
    : undefined;
  const collectionSearchTerm = collectionSearch.trim().toLowerCase();
  const hasCollectionSearch = collectionSearchTerm.length > 0;

  const childFoldersByParent = useMemo(() => {
    const map = new Map<string, CollectionFolder[]>();
    folders.forEach((folder) => {
      const key = folder.parentFolderId ?? "__root";
      const list = map.get(key);
      if (list) {
        list.push(folder);
      } else {
        map.set(key, [folder]);
      }
    });
    return map;
  }, [folders]);

  const requestsByFolder = useMemo(() => {
    const map = new Map<string, typeof requests>();
    requests.forEach((request) => {
      const key = request.folderId ?? "__root";
      const list = map.get(key);
      if (list) {
        list.push(request);
      } else {
        map.set(key, [request]);
      }
    });
    return map;
  }, [requests]);

  const treeVisibility = useMemo(() => {
    if (!hasCollectionSearch) {
      return null;
    }

    const visibleFolderIds = new Set<string>();
    const visibleRequestIds = new Set<string>();

    const matchesSearch = (value: string): boolean =>
      value.toLowerCase().includes(collectionSearchTerm);

    const addFolderWithAncestors = (folderId?: string): void => {
      let current = folderId;

      while (current) {
        if (visibleFolderIds.has(current)) {
          break;
        }

        visibleFolderIds.add(current);
        current = folderById.get(current)?.parentFolderId;
      }
    };

    const addFolderDescendants = (folderId: string): void => {
      const stack = [folderId];

      while (stack.length > 0) {
        const current = stack.pop();
        if (!current) {
          continue;
        }

        if (!visibleFolderIds.has(current)) {
          visibleFolderIds.add(current);
        }

        (requestsByFolder.get(current) ?? []).forEach((request) => {
          visibleRequestIds.add(request.id);
        });

        (childFoldersByParent.get(current) ?? []).forEach((child) => {
          stack.push(child.id);
        });
      }
    };

    requests.forEach((request) => {
      if (!matchesSearch(request.name) && !matchesSearch(request.url)) {
        return;
      }

      visibleRequestIds.add(request.id);
      addFolderWithAncestors(request.folderId);
    });

    folders.forEach((folder) => {
      if (!matchesSearch(folder.name)) {
        return;
      }

      addFolderWithAncestors(folder.id);
      addFolderDescendants(folder.id);
    });

    return { visibleFolderIds, visibleRequestIds };
  }, [
    hasCollectionSearch,
    collectionSearchTerm,
    folders,
    requests,
    folderById,
    childFoldersByParent,
    requestsByFolder,
  ]);

  const hasTreeResults =
    !treeVisibility ||
    treeVisibility.visibleFolderIds.size > 0 ||
    treeVisibility.visibleRequestIds.size > 0;

  useEffect(() => {
    setRuntimeError(null);
    setRuntimeResponse(null);
  }, [data.selectedRequestId]);

  useEffect(() => {
    setSelectedFolderId(undefined);
    setSelectedRequestIds([]);
    setIsCollectionMenuOpen(false);
    setFolderMenuId(null);
    setRequestMenuId(null);
  }, [data.selectedCollectionId]);

  useEffect(() => {
    if (!historyFocusRequestId) {
      return;
    }

    const exists = workspaceHistory.some((entry) => entry.requestId === historyFocusRequestId);
    if (!exists) {
      setHistoryFocusRequestId(null);
    }
  }, [historyFocusRequestId, workspaceHistory]);

  useEffect(() => {
    setCollapsedJsonPaths(new Set());
  }, [runtimeResponse?.body]);

  useEffect(() => {
    if (selectedFolderId && !folderById.has(selectedFolderId)) {
      setSelectedFolderId(undefined);
    }
  }, [selectedFolderId, folderById]);

  useEffect(() => {
    if (isGlobalsOpen) {
      setGlobalHeadersDraft(globalHeaders.map((item) => ({ ...item })));
      setGlobalVariablesDraft(globalVariables.map((item) => ({ ...item })));
    }
  }, [isGlobalsOpen, globalHeaders, globalVariables]);

  useEffect(() => {
    if (!actionMessage) {
      return;
    }

    const timer = globalThis.window.setTimeout(() => {
      setActionMessage(null);
    }, 2400);

    return () => {
      globalThis.window.clearTimeout(timer);
    };
  }, [actionMessage]);

  useEffect(() => {
    setSelectedRequestIds((previous) =>
      previous.filter((id) => requests.some((request) => request.id === id)),
    );
  }, [requests]);

  useEffect(() => {
    const onPointerDown = (event: globalThis.PointerEvent) => {
      const target = event.target as Node;
      if (
        collectionMenuRef.current &&
        !collectionMenuRef.current.contains(target)
      ) {
        setIsCollectionMenuOpen(false);
      }

      const targetElement = event.target as Element | null;
      if (!targetElement?.closest(".folder-menu")) {
        setFolderMenuId(null);
      }
      if (!targetElement?.closest(".request-menu")) {
        setRequestMenuId(null);
      }
    };

    globalThis.window.addEventListener("pointerdown", onPointerDown);
    return () => {
      globalThis.window.removeEventListener("pointerdown", onPointerDown);
    };
  }, []);

  const toggleJsonPath = useCallback((path: string) => {
    setCollapsedJsonPaths((previous) => {
      const next = new Set(previous);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  const responseJson = useMemo(
    () => (runtimeResponse ? tryParseResponseJson(runtimeResponse) : undefined),
    [runtimeResponse],
  );

  const jsonPrettyLines = useMemo(() => {
    if (responseJson === undefined) {
      return [];
    }

    return buildJsonViewerLines({
      value: responseJson,
      path: "$",
      depth: 0,
      isLast: true,
      collapsedPaths: collapsedJsonPaths,
      onToggle: toggleJsonPath,
    });
  }, [responseJson, collapsedJsonPaths, toggleJsonPath]);

  const responsePretty = useMemo(
    () => (runtimeResponse ? formatPrettyBody(runtimeResponse) : ""),
    [runtimeResponse],
  );

  const activeSectionMeta: Record<SidebarSection, string> = {
    Collections: `${requests.length} requests`,
    History: `${workspaceHistory.length} records`,
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

  const openCreateFolderDialog = (parentFolderId?: string) => {
    setFolderNameDraft("");
    setFolderDialog({ mode: "create", parentFolderId });
  };

  const openRenameFolderDialog = (folder: CollectionFolder) => {
    setFolderNameDraft(folder.name);
    setFolderDialog({ mode: "rename", folderId: folder.id });
  };

  const submitFolderDialog = () => {
    if (!folderDialog) {
      return;
    }

    const name = folderNameDraft.trim();
    if (!name) {
      setActionMessage("Folder name is required");
      return;
    }

    if (folderDialog.mode === "create") {
      createCollectionFolder({
        name,
        parentFolderId: folderDialog.parentFolderId,
      });
      setActionMessage("Folder created");
    } else {
      renameCollectionFolder(folderDialog.folderId, name);
      setActionMessage("Folder renamed");
    }

    setFolderDialog(null);
  };

  const removeFolder = (folder: CollectionFolder) => {
    deleteCollectionFolder(folder.id);
    if (selectedFolderId === folder.id) {
      setSelectedFolderId(folder.parentFolderId);
    }
    setActionMessage("Folder deleted");
  };

  const cloneFolder = (folder: CollectionFolder) => {
    duplicateCollectionFolder(folder.id);
    setActionMessage("Folder duplicated");
  };

  const openMoveRequestDialog = (requestId: string) => {
    const request = requests.find((item) => item.id === requestId);
    if (!request) {
      return;
    }

    setMovingRequestId(requestId);
    setMovingFolderDraft(request.folderId ?? "__root");
    setIsMoveRequestOpen(true);
  };

  const submitMoveRequest = () => {
    if (!movingRequestId) {
      return;
    }

    moveRequestToFolder(
      movingRequestId,
      movingFolderDraft === "__root" ? undefined : movingFolderDraft,
    );
    setIsMoveRequestOpen(false);
    setMovingRequestId(null);
    setActionMessage("Request moved");
  };

  const removeRequest = (requestId: string) => {
    deleteRequest(requestId);
    setSelectedRequestIds((previous) => previous.filter((id) => id !== requestId));
    setActionMessage("Request deleted");
  };

  const cloneRequest = (requestId: string) => {
    duplicateRequest(requestId);
    setActionMessage("Request duplicated");
  };

  const copyRequest = async (requestId: string) => {
    const request = requests.find((item) => item.id === requestId);
    if (!request) {
      return;
    }

    try {
      await globalThis.navigator.clipboard.writeText(
        JSON.stringify(
          {
            method: request.method,
            url: request.url,
            headers: request.headers,
            queryParams: request.queryParams,
            auth: request.auth,
            body: request.body ?? "",
          },
          null,
          2,
        ),
      );
      setActionMessage("Request JSON copied");
    } catch {
      setActionMessage("Clipboard not available");
    }
  };

  const toggleRequestSelection = (requestId: string, checked: boolean) => {
    setSelectedRequestIds((previous) => {
      if (checked) {
        if (previous.includes(requestId)) {
          return previous;
        }
        return [...previous, requestId];
      }

      return previous.filter((id) => id !== requestId);
    });
  };

  const selectAllRequests = () => {
    setSelectedRequestIds(requests.map((request) => request.id));
    setIsCollectionMenuOpen(false);
    setActionMessage("All requests selected");
  };

  const clearSelectedRequests = () => {
    setSelectedRequestIds([]);
    setIsCollectionMenuOpen(false);
    setActionMessage("Selection cleared");
  };

  const openCollectionRenameDialog = () => {
    if (!activeCollection) {
      return;
    }

    setCollectionNameDraft(activeCollection.name);
    setIsCollectionRenameOpen(true);
    setIsCollectionMenuOpen(false);
  };

  const submitCollectionRename = () => {
    if (!activeCollection) {
      return;
    }

    const nextName = collectionNameDraft.trim();
    if (!nextName) {
      setActionMessage("Collection name is required");
      return;
    }

    renameCollection(activeCollection.id, nextName);
    setIsCollectionRenameOpen(false);
    setActionMessage("Collection renamed");
  };

  const duplicateActiveCollection = () => {
    if (!activeCollection) {
      return;
    }

    duplicateCollection(activeCollection.id);
    setSelectedRequestIds([]);
    setIsCollectionMenuOpen(false);
    setActionMessage("Collection duplicated");
  };

  const removeActiveCollection = () => {
    if (!activeCollection) {
      return;
    }

    if (collections.length <= 1) {
      setActionMessage("Cannot delete the last collection");
      setIsCollectionMenuOpen(false);
      return;
    }

    deleteCollection(activeCollection.id);
    setSelectedRequestIds([]);
    setIsCollectionMenuOpen(false);
    setActionMessage("Collection deleted");
  };

  const moveSelectedRequestsToRoot = () => {
    if (!selectedRequestIds.length) {
      return;
    }

    moveRequestsToFolder(selectedRequestIds, undefined);
    setIsCollectionMenuOpen(false);
    setActionMessage("Selected requests moved to root");
  };

  const openBulkMoveSelected = () => {
    if (!selectedRequestIds.length) {
      return;
    }

    setBulkMoveFolderDraft("__root");
    setIsBulkMoveOpen(true);
    setIsCollectionMenuOpen(false);
  };

  const submitBulkMove = () => {
    if (!selectedRequestIds.length) {
      setIsBulkMoveOpen(false);
      return;
    }

    moveRequestsToFolder(
      selectedRequestIds,
      bulkMoveFolderDraft === "__root" ? undefined : bulkMoveFolderDraft,
    );
    setIsBulkMoveOpen(false);
    setActionMessage(
      bulkMoveFolderDraft === "__root"
        ? "Selected requests moved to root"
        : "Selected requests moved",
    );
  };

  const duplicateSelected = () => {
    if (!selectedRequestIds.length) {
      return;
    }

    duplicateRequests(selectedRequestIds);
    setIsCollectionMenuOpen(false);
    setActionMessage("Selected requests duplicated");
  };

  const deleteSelected = () => {
    if (!selectedRequestIds.length) {
      return;
    }

    deleteRequests(selectedRequestIds);
    setSelectedRequestIds([]);
    setIsCollectionMenuOpen(false);
    setActionMessage("Selected requests deleted");
  };

  const getFolderDescendantIds = (rootFolderId: string): Set<string> => {
    const descendants = new Set<string>([rootFolderId]);
    const queue = [rootFolderId];

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) {
        continue;
      }

      folders.forEach((folder) => {
        if (folder.parentFolderId === current && !descendants.has(folder.id)) {
          descendants.add(folder.id);
          queue.push(folder.id);
        }
      });
    }

    return descendants;
  };

  const canDropIntoFolder = (targetFolderId?: string): boolean => {
    if (!dragItem) {
      return false;
    }

    if (dragItem.type === "request") {
      const request = requests.find((item) => item.id === dragItem.id);
      if (!request) {
        return false;
      }

      if ((request.folderId ?? undefined) === targetFolderId) {
        return false;
      }

      if (!targetFolderId) {
        return true;
      }

      const targetFolder = folderById.get(targetFolderId);
      return Boolean(targetFolder && targetFolder.collectionId === request.collectionId);
    }

    const movingFolder = folderById.get(dragItem.id);
    if (!movingFolder) {
      return false;
    }

    if ((movingFolder.parentFolderId ?? undefined) === targetFolderId) {
      return false;
    }

    if (!targetFolderId) {
      return true;
    }

    const targetFolder = folderById.get(targetFolderId);
    if (!targetFolder) {
      return false;
    }

    if (targetFolder.collectionId !== movingFolder.collectionId) {
      return false;
    }

    const descendants = getFolderDescendantIds(movingFolder.id);
    return !descendants.has(targetFolderId);
  };

  const handleDragStart =
    (item: DragItem) =>
    (event: DragEvent<HTMLElement>): void => {
      setDragItem(item);
      setDragOverTarget(null);
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", `${item.type}:${item.id}`);
    };

  const handleDragEnd = (): void => {
    setDragItem(null);
    setDragOverTarget(null);
  };

  const handleDragOverTarget =
    (targetFolderId?: string) =>
    (event: DragEvent<HTMLElement>): void => {
      event.stopPropagation();
      if (!canDropIntoFolder(targetFolderId)) {
        return;
      }

      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      setDragOverTarget(targetFolderId ?? "__root");
    };

  const handleDragLeaveTarget =
    (targetFolderId?: string) =>
    (event: DragEvent<HTMLElement>): void => {
      event.stopPropagation();
      if (dragOverTarget === (targetFolderId ?? "__root")) {
        setDragOverTarget(null);
      }
    };

  const handleDropTarget =
    (targetFolderId?: string) =>
    (event: DragEvent<HTMLElement>): void => {
      event.stopPropagation();
      if (!canDropIntoFolder(targetFolderId) || !dragItem) {
        return;
      }

      event.preventDefault();

      if (dragItem.type === "request") {
        moveRequestToFolder(dragItem.id, targetFolderId);
        setActionMessage(
          targetFolderId
            ? `Request moved to ${folderById.get(targetFolderId)?.name ?? "folder"}`
            : "Request moved to root",
        );
      } else {
        moveCollectionFolder(dragItem.id, targetFolderId);
        setActionMessage(
          targetFolderId
            ? `Folder moved to ${folderById.get(targetFolderId)?.name ?? "folder"}`
            : "Folder moved to root",
        );
      }

      setDragItem(null);
      setDragOverTarget(null);
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
    let childFolders = folders
      .filter((folder) => (folder.parentFolderId ?? "__root") === folderKey)
      .sort((a, b) => a.name.localeCompare(b.name));
    let directRequests = requests.filter(
      (request) => (request.folderId ?? "__root") === folderKey,
    );

    if (treeVisibility) {
      childFolders = childFolders.filter((folder) =>
        treeVisibility.visibleFolderIds.has(folder.id),
      );
      directRequests = directRequests.filter((request) =>
        treeVisibility.visibleRequestIds.has(request.id),
      );
    }

    const nodes: ReactElement[] = [];

    childFolders.forEach((folder) => {
      const expanded = folder.expanded ?? true;
      nodes.push(
        <li key={folder.id} className="tree-node">
          <div
            className={
              [
                "folder-row",
                selectedFolderId === folder.id ? "active" : "",
                dragOverTarget === folder.id ? "drop-target" : "",
              ]
                .filter(Boolean)
                .join(" ")
            }
            style={{ paddingLeft: `${10 + depth * 16}px` }}
            draggable
            onDragStart={handleDragStart({ type: "folder", id: folder.id })}
            onDragEnd={handleDragEnd}
            onDragOver={handleDragOverTarget(folder.id)}
            onDragLeave={handleDragLeaveTarget(folder.id)}
            onDrop={handleDropTarget(folder.id)}
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
              <div className="folder-menu">
                <button
                  type="button"
                  className="icon-btn-sm menu-trigger-sm"
                  onClick={(event) => {
                    event.stopPropagation();
                    setFolderMenuId((current) =>
                      current === folder.id ? null : folder.id,
                    );
                  }}
                  title="Folder actions"
                >
                  ...
                </button>

                {folderMenuId === folder.id ? (
                  <div className="dropdown-menu folder-dropdown">
                    <button
                      type="button"
                      className="dropdown-item"
                      onClick={() => {
                        createRequest({ folderId: folder.id });
                        setFolderMenuId(null);
                      }}
                    >
                      Add request
                    </button>
                    <button
                      type="button"
                      className="dropdown-item"
                      onClick={() => {
                        openCreateFolderDialog(folder.id);
                        setFolderMenuId(null);
                      }}
                    >
                      Add subfolder
                    </button>
                    <button
                      type="button"
                      className="dropdown-item"
                      onClick={() => {
                        openRenameFolderDialog(folder);
                        setFolderMenuId(null);
                      }}
                    >
                      Rename
                    </button>
                    <button
                      type="button"
                      className="dropdown-item"
                      onClick={() => {
                        cloneFolder(folder);
                        setFolderMenuId(null);
                      }}
                    >
                      Duplicate
                    </button>
                    <button
                      type="button"
                      className="dropdown-item danger"
                      onClick={() => {
                        removeFolder(folder);
                        setFolderMenuId(null);
                      }}
                    >
                      Delete
                    </button>
                  </div>
                ) : null}
              </div>
            </div>
          </div>
          {expanded ? <ul className="tree-children">{renderCollectionTree(folder.id, depth + 1)}</ul> : null}
        </li>,
      );
    });

    directRequests.forEach((request) => {
      nodes.push(
        <li key={request.id} className="tree-node">
          <div
            className={
              request.id === data.selectedRequestId
                ? "tree-request-item active"
                : "tree-request-item"
            }
          >
            <button
              type="button"
              className="tree-request-main"
              style={{ paddingLeft: `${26 + depth * 16}px` }}
              onClick={() => selectRequest(request.id)}
              draggable
              onDragStart={handleDragStart({ type: "request", id: request.id })}
              onDragEnd={handleDragEnd}
            >
              <span className={`method-badge ${getMethodColor(request.method)}`}>
                {request.method}
              </span>
              <span className="tree-request-title">{request.name}</span>
            </button>
            <div className="tree-request-actions">
              <input
                type="checkbox"
                className="request-select"
                checked={selectedRequestIds.includes(request.id)}
                onChange={(event) =>
                  toggleRequestSelection(request.id, event.currentTarget.checked)
                }
                title="Select for bulk actions"
              />
              <div className="request-menu">
                <button
                  type="button"
                  className="icon-btn-sm menu-trigger-sm"
                  onClick={(event) => {
                    event.stopPropagation();
                    setRequestMenuId((current) =>
                      current === request.id ? null : request.id,
                    );
                  }}
                  title="Request actions"
                >
                  ...
                </button>

                {requestMenuId === request.id ? (
                  <div className="dropdown-menu request-dropdown">
                    <button
                      type="button"
                      className="dropdown-item"
                      onClick={() => {
                        cloneRequest(request.id);
                        setRequestMenuId(null);
                      }}
                    >
                      Duplicate
                    </button>
                    <button
                      type="button"
                      className="dropdown-item"
                      onClick={() => {
                        copyRequest(request.id);
                        setRequestMenuId(null);
                      }}
                    >
                      Copy JSON
                    </button>
                    <button
                      type="button"
                      className="dropdown-item"
                      onClick={() => {
                        openMoveRequestDialog(request.id);
                        setRequestMenuId(null);
                      }}
                    >
                      Move
                    </button>
                    <button
                      type="button"
                      className="dropdown-item danger"
                      onClick={() => {
                        removeRequest(request.id);
                        setRequestMenuId(null);
                      }}
                    >
                      Delete
                    </button>
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        </li>,
      );
    });

    return nodes;
  };

  const focusRequestHistory = (requestId: string) => {
    setHistoryFocusRequestId(requestId);

    const request = requestsById.get(requestId);
    if (!request) {
      return;
    }

    if (request.collectionId !== data.selectedCollectionId) {
      selectCollection(request.collectionId);
    }
    selectRequest(request.id);
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
              aria-label={section}
            >
              {getSidebarIcon(section)}
            </button>
          ))}
        </div>
        <div className="rail-footer">macOS</div>
      </aside>

      <section className="catalog-pane motion-enter delay-1">
        <header className="catalog-header">
          <h1>Collections</h1>
          <p>{activeCollection?.name ?? "Workspace collections"}</p>
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
            <div className="collection-select-row" ref={collectionMenuRef}>
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
              <button
                type="button"
                className="menu-trigger"
                onClick={() => setIsCollectionMenuOpen((value) => !value)}
                title="Collection actions"
              >
                ...
              </button>

              {isCollectionMenuOpen ? (
                <div className="dropdown-menu">
                  <button
                    type="button"
                    className="dropdown-item"
                    onClick={openCollectionRenameDialog}
                  >
                    Rename collection
                  </button>
                  <button
                    type="button"
                    className="dropdown-item"
                    onClick={duplicateActiveCollection}
                    disabled={!activeCollection}
                  >
                    Duplicate collection
                  </button>
                  <button
                    type="button"
                    className="dropdown-item danger"
                    onClick={removeActiveCollection}
                    disabled={!activeCollection}
                  >
                    Delete collection
                  </button>

                  <div className="dropdown-divider" />

                  <button type="button" className="dropdown-item" onClick={selectAllRequests}>
                    Select all requests
                  </button>
                  <button
                    type="button"
                    className="dropdown-item"
                    onClick={clearSelectedRequests}
                    disabled={!selectedRequestIds.length}
                  >
                    Clear selected ({selectedRequestIds.length})
                  </button>
                  <button
                    type="button"
                    className="dropdown-item"
                    onClick={openBulkMoveSelected}
                    disabled={!selectedRequestIds.length}
                  >
                    Move selected to folder
                  </button>
                  <button
                    type="button"
                    className="dropdown-item"
                    onClick={moveSelectedRequestsToRoot}
                    disabled={!selectedRequestIds.length}
                  >
                    Move selected to root
                  </button>
                  <button
                    type="button"
                    className="dropdown-item"
                    onClick={duplicateSelected}
                    disabled={!selectedRequestIds.length}
                  >
                    Duplicate selected
                  </button>
                  <button
                    type="button"
                    className="dropdown-item danger"
                    onClick={deleteSelected}
                    disabled={!selectedRequestIds.length}
                  >
                    Delete selected
                  </button>
                </div>
              ) : null}
            </div>
          </label>
        </div>

        <div className="catalog-meta">
          <span>{activeSection}</span>
          <span>{activeSectionMeta[activeSection]}</span>
        </div>

        {activeSection === "Collections" ? (
          <>
            <div className="catalog-actions">
              <button
                type="button"
                className="outline-btn"
                onClick={() => createRequest({ folderId: selectedFolderId })}
              >
                + Request
              </button>
              <button
                type="button"
                className="outline-btn"
                onClick={() => openCreateFolderDialog(selectedFolderId)}
              >
                + Folder
              </button>
              <button
                type="button"
                className="outline-btn"
                onClick={() => setSelectedFolderId(undefined)}
              >
                Root
              </button>
            </div>
            <div className="collection-search-wrap">
              <input
                className="collection-search-input"
                value={collectionSearch}
                onChange={(event) => setCollectionSearch(event.currentTarget.value)}
                placeholder="Search collections"
                aria-label="Search collections"
              />
              {hasCollectionSearch ? (
                <button
                  type="button"
                  className="collection-search-clear"
                  onClick={() => setCollectionSearch("")}
                  aria-label="Clear search"
                >
                  ×
                </button>
              ) : null}
            </div>
            {selectedFolderId ? (
              <p className="selected-folder-pill">
                Folder selected: {selectedFolder?.name ?? "unknown"}
              </p>
            ) : (
              <p className="selected-folder-pill">Folder selected: root</p>
            )}
            {selectedRequestIds.length ? (
              <p className="selected-folder-pill">
                Selected requests: {selectedRequestIds.length}
              </p>
            ) : null}
            {actionMessage ? <p className="selected-folder-pill">{actionMessage}</p> : null}
            <ul
              className={dragOverTarget === "__root" ? "tree-root drop-target" : "tree-root"}
              onDragOver={handleDragOverTarget(undefined)}
              onDragLeave={handleDragLeaveTarget(undefined)}
              onDrop={handleDropTarget(undefined)}
            >
              {hasTreeResults ? (
                renderCollectionTree(undefined, 0)
              ) : (
                <li className="hint">No matches for “{collectionSearch}”.</li>
              )}
            </ul>
          </>
        ) : null}

        {activeSection === "History" ? (
          <>
            {historyFocusedRequest ? (
              <div className="history-filter-row">
                <p className="selected-folder-pill">
                  History: {historyFocusedRequest.name}
                </p>
                <button
                  type="button"
                  className="outline-btn history-clear-btn"
                  onClick={() => setHistoryFocusRequestId(null)}
                >
                  All history
                </button>
              </div>
            ) : null}
            <ul className="history-compact">
              {history.length ? (
                history.map((entry) => (
                  <li key={entry.id}>
                    <button
                      type="button"
                      className={
                        entry.requestId === historyFocusRequestId
                          ? "history-row active"
                          : "history-row"
                      }
                      onClick={() => focusRequestHistory(entry.requestId)}
                      title="Show history for this request"
                    >
                      <div className="history-row-main">
                        <span className={`method-badge ${getMethodColor(entry.method)}`}>
                          {entry.method}
                        </span>
                        <p className="history-url">{entry.url}</p>
                      </div>
                      <div className="history-meta">
                        <span
                          className={
                            entry.statusCode >= 400 || entry.statusCode === 0
                              ? "history-status history-status-error"
                              : "history-status"
                          }
                        >
                          {entry.statusCode || "ERR"}
                        </span>
                        <span>{entry.durationMs} ms</span>
                        <span>{bytesToReadable(entry.responseSizeBytes)}</span>
                      </div>
                    </button>
                  </li>
                ))
              ) : (
                <li className="hint">No history yet. Run your first request.</li>
              )}
            </ul>
          </>
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
          <div className="top-heading">
            <h2 className="top-title">
              {activeRequest ? activeRequest.name : "No request selected"}
            </h2>
            <p className="top-subtitle">RequestPorter · folders, globals and real requests</p>
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
                  <span className="request-tab-label">{request.name}</span>
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
                responseJson !== undefined ? (
                  <div className="response-viewer json-viewer animate-in">
                    {jsonPrettyLines.map((line, index) => (
                      <div key={line.id} className="json-line">
                        <span className="json-line-number">{index + 1}</span>
                        <div
                          className="json-line-content"
                          style={{ paddingLeft: `${line.depth * 14}px` }}
                        >
                          {line.content}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <pre className="response-viewer animate-in">{responsePretty}</pre>
                )
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

      {isCollectionRenameOpen ? (
        <div className="curl-modal-backdrop">
          <div className="curl-modal compact-modal">
            <header>
              <h3>Rename Collection</h3>
              <button type="button" onClick={() => setIsCollectionRenameOpen(false)}>
                x
              </button>
            </header>
            <label className="dialog-field">
              Collection name
              <input
                value={collectionNameDraft}
                onChange={(event) => setCollectionNameDraft(event.currentTarget.value)}
                placeholder="Collection name"
              />
            </label>
            <footer>
              <button
                type="button"
                className="outline-btn"
                onClick={() => setIsCollectionRenameOpen(false)}
              >
                Cancel
              </button>
              <button type="button" className="send-button" onClick={submitCollectionRename}>
                Save
              </button>
            </footer>
          </div>
        </div>
      ) : null}

      {isBulkMoveOpen ? (
        <div className="curl-modal-backdrop">
          <div className="curl-modal compact-modal">
            <header>
              <h3>Move Selected Requests</h3>
              <button type="button" onClick={() => setIsBulkMoveOpen(false)}>
                x
              </button>
            </header>
            <p className="hint">Selected: {selectedRequests.length}</p>
            <label className="dialog-field">
              Destination
              <select
                value={bulkMoveFolderDraft}
                onChange={(event) => setBulkMoveFolderDraft(event.currentTarget.value)}
              >
                <option value="__root">Root</option>
                {folders.map((folder) => (
                  <option key={folder.id} value={folder.id}>
                    {folder.name}
                  </option>
                ))}
              </select>
            </label>
            <footer>
              <button
                type="button"
                className="outline-btn"
                onClick={() => setIsBulkMoveOpen(false)}
              >
                Cancel
              </button>
              <button type="button" className="send-button" onClick={submitBulkMove}>
                Move
              </button>
            </footer>
          </div>
        </div>
      ) : null}

      {folderDialog ? (
        <div className="curl-modal-backdrop">
          <div className="curl-modal compact-modal">
            <header>
              <h3>
                {folderDialog.mode === "create"
                  ? "Create Folder"
                  : "Rename Folder"}
              </h3>
              <button type="button" onClick={() => setFolderDialog(null)}>
                x
              </button>
            </header>
            <label className="dialog-field">
              Folder name
              <input
                value={folderNameDraft}
                onChange={(event) => setFolderNameDraft(event.currentTarget.value)}
                placeholder="New Folder"
              />
            </label>
            <footer>
              <button
                type="button"
                className="outline-btn"
                onClick={() => setFolderDialog(null)}
              >
                Cancel
              </button>
              <button type="button" className="send-button" onClick={submitFolderDialog}>
                {folderDialog.mode === "create" ? "Create" : "Save"}
              </button>
            </footer>
          </div>
        </div>
      ) : null}

      {isMoveRequestOpen ? (
        <div className="curl-modal-backdrop">
          <div className="curl-modal compact-modal">
            <header>
              <h3>Move Request</h3>
              <button
                type="button"
                onClick={() => {
                  setIsMoveRequestOpen(false);
                  setMovingRequestId(null);
                }}
              >
                x
              </button>
            </header>
            <p className="hint">
              {movingRequest ? `Request: ${movingRequest.name}` : "Select target folder"}
            </p>
            <label className="dialog-field">
              Destination
              <select
                value={movingFolderDraft}
                onChange={(event) => setMovingFolderDraft(event.currentTarget.value)}
              >
                <option value="__root">Root</option>
                {folders.map((folder) => (
                  <option key={folder.id} value={folder.id}>
                    {folder.name}
                  </option>
                ))}
              </select>
            </label>
            <footer>
              <button
                type="button"
                className="outline-btn"
                onClick={() => {
                  setIsMoveRequestOpen(false);
                  setMovingRequestId(null);
                }}
              >
                Cancel
              </button>
              <button type="button" className="send-button" onClick={submitMoveRequest}>
                Move
              </button>
            </footer>
          </div>
        </div>
      ) : null}

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
