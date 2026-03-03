# Architecture (MVP, macOS Apple Silicon)

## 1. Platform and stack

## Desktop shell

- Primary choice: `Tauri 2 + Rust` (меньший размер бандла, лучшее потребление RAM/CPU на Apple Silicon).
- UI: `React + TypeScript + Vite`.
- State: `Zustand` (будет добавлен в feature-ветке state-layer).
- Editor: `Monaco Editor` (позже в request builder/скриптах).

## Runtime and request execution

- HTTP engine: `undici/fetch` (Node-compatible semantics where needed).
- Script sandbox (phase-in):
  - MVP: ограниченный pre-request/tests runtime.
  - Post-MVP: расширение до максимально близкой совместимости с Postman scripts.

## Local data

- Workspace files: JSON (Postman v2.1-compatible schema where possible).
- Fast indexing/history: SQLite.
- Secrets: macOS Keychain integration (через Tauri plugins).

## 2. High-level modules

1. `app-shell`: окна, вкладки, меню, системные интеграции.
2. `workspace-core`: коллекции, папки, запросы, окружения, переменные.
3. `request-engine`: сборка запроса, auth, send/retry, response parse.
4. `history-store`: запись и поиск по выполненным запросам.
5. `interop`: import/export (Postman/cURL/OpenAPI).
6. `sync-collab` (feature-flagged): приглашения, роли, realtime events.

## 3. Data model (minimal)

1. Workspace
   - `id`, `name`, `type(personal/team)`, `members[]`.
2. Collection
   - `id`, `workspaceId`, `name`, `folders[]`, `requests[]`.
3. Request
   - `id`, `method`, `url`, `headers`, `query`, `body`, `auth`, `tests`, `preRequest`.
4. Environment
   - `id`, `name`, `variables[]`.
5. HistoryEntry
   - `requestSnapshot`, `status`, `durationMs`, `responseSize`, `timestamp`.

## 4. Compatibility policy

1. Import parser first normalizes Postman v2/v2.1 to internal schema.
2. Export always targets Postman v2.1 JSON.
3. Unsupported fields are preserved in `x-requestporter-meta` to avoid destructive round-trips.

## 5. Security baseline

1. Secrets never persisted as plaintext in sync payloads.
2. Local encryption for sensitive values (token/keys), key material tied to OS keychain.
3. Script runtime isolated from filesystem by default.

## 6. Testing strategy

1. Contract tests for import/export fixtures (golden files).
2. Integration tests for request builder and auth modes.
3. UI smoke tests for core flows: create request, send, save to collection, export.
4. Performance checks on arm64 Mac for startup time and memory.
