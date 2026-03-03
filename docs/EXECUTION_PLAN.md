# Execution Plan (12 weeks, MVP)

## Week 1-2: Foundation

1. Инициализация desktop проекта (Tauri + React + TS).
2. Базовая навигация: sidebar + tabs + workspace selector.
3. Схема локального хранилища (JSON + SQLite history).
4. CI baseline: lint/test/build для macOS arm64.

## Week 3-4: Request Builder

1. CRUD запросов и коллекций.
2. Request composer: URL, headers, query, body modes.
3. Auth P0: None, Basic, Bearer, API Key.
4. Response viewer: status/time/size + raw/json/xml.

## Week 5-6: Environments + History

1. Environment variables + interpolation `{{var}}`.
2. История запросов: запись, фильтры, поиск, clear.
3. Сохранение истории обратно в коллекцию.

## Week 7-8: Import/Export

1. Postman v2/v2.1 import/export.
2. cURL import.
3. OpenAPI 3.0 import (core paths/methods/examples).
4. Regression fixtures и round-trip тесты.

## Week 9-10: Team features (MVP cut)

1. Team workspace primitives + роли `view/edit`.
2. Invite flow (email/token based).
3. Базовая синхронизация изменений для team workspace.

## Week 11-12: Hardening + Beta

1. Crash reporting + performance tuning arm64.
2. Onboarding: "Import from Postman" first-run flow.
3. Закрытый beta релиз, сбор метрик, список критических багов.

## Release gates

1. Postman import success >=95% на тестовых коллекциях.
2. Нет P0/P1 багов в core flow.
3. Median startup time <= 2.5s на M1/M2.
4. Полный сценарий "создать запрос -> выполнить -> сохранить -> экспортировать" стабилен.

## Backlog after MVP (free phase)

1. Collection Runner + data-driven tests.
2. Git sync UX and pull-request friendly diffing.
3. Comments + activity feed.
4. Mock servers.
