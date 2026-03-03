# Product Requirements Document (PRD)

## 1. Product Summary

RequestPorter — desktop API client для команд разработки (2-20 человек), которым нужен бесплатный и совместимый с Postman инструмент.

### Product goals (MVP, 3 месяца)

1. Дать команде до 5 человек рабочий сценарий совместной работы без оплаты.
2. Закрыть миграцию с Postman: импорт/экспорт коллекций v2/v2.1 без потери структуры.
3. Обеспечить стабильный local-first workflow: история, окружения, версия в Git.

### Non-goals (MVP)

1. Монетизация и подписки.
2. Enterprise security/compliance.
3. Полный parity по всем edge-case скриптам Postman.

## 2. Target users

1. Малые dev-команды (стартапы, агентства, фриланс-группы).
2. QA/Automation инженеры, которым нужен коллекционный runner позже.
3. Open-source команды, предпочитающие git-native хранение.

## 3. Free-only policy (current)

- Все функции MVP бесплатны для всех пользователей.
- Ограничения только технические (например, размер файлов, rate limits API sync), без платных тарифов.
- В кодовой базе не добавляются billing dependencies, paywall UI, feature flags "paid only".

## 4. MVP Scope (P0/P1)

## P0 (обязательно для релиза)

1. Workspaces: personal/team, приглашения, роли `view/edit`.
2. Collections: CRUD, папки, переменные, environments.
3. Request Builder: методы, URL/headers/query/body, auth (None/Basic/Bearer/API Key/OAuth basic), response viewer.
4. History: лог выполненных запросов, поиск и фильтры.
5. Import/Export:
   - Postman v2/v2.1 collections
   - Environments JSON
   - cURL import
   - OpenAPI 3.0 import (минимум)
6. Базовый UI: sidebar, tabs, глобальный поиск, light/dark.

## P1 (после релиза MVP)

1. Collection Runner + базовые test scripts (chai-like assertions).
2. Git sync UX (commit/push/pull в интерфейсе).
3. Комментарии и activity feed.

## 5. Success metrics (MVP)

1. `Import success rate (Postman v2/v2.1) >= 95%` на тестовом наборе коллекций.
2. `Crash-free sessions >= 99.5%`.
3. `Time to first successful request <= 5 min` для нового пользователя.
4. `>= 200 weekly active users` к концу 3-го месяца закрытого beta.

## 6. Risks

1. Несовместимость в postman script runtime.
2. Сложность realtime sync для конфликтных изменений.
3. Разрастание scope из-за раннего добавления enterprise-функций.

## 7. Decisions locked for MVP

1. macOS Apple Silicon first.
2. Local-first storage как источник истины.
3. Free-only стратегия до достижения продуктового fit.
