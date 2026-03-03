# RequestPorter

Desktop API-клиент для тестирования и разработки API с фокусом на командную работу.

## Текущий продуктовый режим

- Платформа: macOS (Apple Silicon, arm64) как первый приоритет.
- Модель: пока полностью бесплатно, без подписок и биллинга.
- Core value: совместимость с Postman + локальное хранение + командная работа.

## Quick Start

```bash
npm install
npm run tauri dev
```

Проверка production-пайплайна без упаковки `.app/.dmg`:

```bash
npm run tauri build -- --debug --no-bundle --ci
```

## Live Request Testing

В текущем UI уже работает реальная отправка HTTP-запросов через Rust backend (`reqwest`), поэтому можно тестировать публичные API сразу после старта.

Быстрый smoke test:

1. Выбрать `GET /todos/1`
2. Нажать `Send`
3. Проверить `Status/Time/Size` + `Pretty/Raw/Headers` в response viewer

Также есть `POST /posts` с JSON body для проверки write-запроса.

### New UX features

- Multi-tab requests (открытие/закрытие вкладок запросов).
- Auth presets: `None`, `Bearer Token`, `API Key` (header/query).
- `Import cURL` (создаёт новый запрос из команды cURL).

## Ключевые принципы

- Local-first: данные проекта хранятся локально в git-friendly формате.
- Postman-compatible: импорт/экспорт коллекций v2/v2.1 и окружений.
- Open core: архитектура готова к self-hosting в следующих фазах.

## Документация

- [PRD](docs/PRD.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Execution Plan (12 недель)](docs/EXECUTION_PLAN.md)

## Что не делаем сейчас

- Подписки, paywall, billing, лицензирование.
- Enterprise-функции (SSO, RBAC, audit logs).
- Полноценный cloud-first сценарий.
