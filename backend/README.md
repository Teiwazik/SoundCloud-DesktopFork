# SoundCloud Desktop — Backend

BFF-сервер для десктопного приложения SoundCloud. Проксирует SoundCloud API, управляет OAuth 2.1 + PKCE авторизацией, хранит сессии в PostgreSQL.

## Стек

NestJS 11 · TypeORM · PostgreSQL 17 · Biome · Docker

---

## 1. Регистрация приложения в SoundCloud

1. Авторизуйся на [soundcloud.com](https://soundcloud.com)
2. Перейди на [soundcloud.com/you/apps](https://soundcloud.com/you/apps/)
3. Создай новое приложение
4. Получишь два секрета:

| Переменная | Откуда |
|---|---|
| `SOUNDCLOUD_CLIENT_ID` | Страница приложения, поле **Client ID** |
| `SOUNDCLOUD_CLIENT_SECRET` | Страница приложения, поле **Client Secret** |

5. Там же укажи **Redirect URI**:

```
http://localhost:3000/auth/callback
```

> Этот URL должен **точно совпадать** с тем, что указан в `.env` (`SOUNDCLOUD_REDIRECT_URI`).
> Для прода — заменить на реальный домен.

---

## 2. Настройка окружения

```bash
cp .env.example .env
```

Заполни `.env`:

```env
SOUNDCLOUD_CLIENT_ID=твой_client_id
SOUNDCLOUD_CLIENT_SECRET=твой_client_secret
SOUNDCLOUD_REDIRECT_URI=http://localhost:3000/auth/callback

DATABASE_HOST=localhost
DATABASE_PORT=5432
DATABASE_USERNAME=soundcloud
DATABASE_PASSWORD=soundcloud
DATABASE_NAME=soundcloud_desktop

PORT=3000
```

Для локального запуска без внешнего PostgreSQL можно вместо этого включить встроенный dev-режим:

```env
DATABASE_DRIVER=pg-mem
```

В этом режиме backend поднимает in-memory Postgres-эмуляцию только для локальной разработки и проверки API.

### Дополнительные переменные (опционально)

| Переменная | Описание |
|---|---|
| `DATABASE_DRIVER` | `postgres` по умолчанию, либо `pg-mem` для локального dev без внешней БД |
| `SC_PROXY_URL` | Прокси URL для API-запросов к SoundCloud |
| `SC_STREAM_PROXY_URL` | Отдельный прокси URL для stream/HLS-запросов |
| `SC_COOKIES` | Cookies с `soundcloud.com` для fallback стриминга GO+/HQ |

---

## 3. Запуск

### Самый простой локальный сценарий под Windows

Если хочешь просто поднять локальный API для десктопа без ебли:

1. Положи `SOUNDCLOUD_CLIENT_ID` и `SOUNDCLOUD_CLIENT_SECRET` в `.env`
2. Запусти `start-local-api.bat`
3. Открой десктопное приложение
4. В приложении зайди в логин и выбери локальный сервер / свои ключи

Если приложение уже установлено в `%LOCALAPPDATA%\soundcloud-desktop\soundcloud-desktop.exe`, можно просто запустить:

```bat
start-local-stack-and-app.bat
```

Этот скрипт:

- поднимет Docker Desktop если он еще не запущен
- стартанет локальный API + PostgreSQL
- после этого откроет десктопное приложение

### Docker (рекомендуется)

```bash
# Dev — с hot-reload, PG в контейнере
docker compose --profile dev up

# Prod — собранный образ + PG
docker compose --profile prod up

# Только база (если запускаешь сервер локально)
docker compose up db
```

### Локально

```bash
pnpm install
pnpm start:dev     # watch mode
pnpm start:debug   # с дебаггером
pnpm build && pnpm start:prod  # production
```

> Требуется запущенный PostgreSQL (см. настройки в `.env`).

---

## 4. Доступные URL

| URL | Описание |
|---|---|
| `http://localhost:3000/health` | Health check |
| `http://localhost:3000/api` | Swagger UI |
| `http://localhost:3000/openapi.json` | OpenAPI-спецификация |

---

## 4.1. Как подключить сервер к SoundCloud Desktop

1. Запусти API на `http://localhost:3000`
2. Открой SoundCloud Desktop
3. На экране логина выбери локальный сервер / custom API flow
4. Если хочешь логиниться через свое приложение SoundCloud, вставь свой `Client ID` и `Client Secret`
5. Авторизуйся как обычно

Если все ок, приложение будет ходить не в удаленный API, а в твой локальный BFF.

---

## 5. Авторизация — как работает

```
Приложение                  Наш бэкенд                 SoundCloud
    │                           │                           │
    ├── GET /auth/login ───────►│                           │
    │◄── { url, sessionId } ────┤                           │
    │                           │                           │
    │   Юзер открывает url ─────┼──────────────────────────►│
    │                           │                           │
    │                           │◄── GET /auth/callback ────┤
    │                           │    ?code=...&state=...    │
    │                           │                           │
    │                           ├── POST /oauth/token ─────►│
    │                           │◄── access_token ──────────┤
    │                           │                           │
    │                           │  Показывает HTML-страницу │
    │                           │  "Успешно" / "Ошибка"     │
    │                           │                           │
    ├── GET /auth/session ─────►│  (по x-session-id)        │
    │◄── { authenticated: true }┤                           │
```

### Эндпоинты авторизации

| Метод | Путь | Описание |
|---|---|---|
| GET | `/auth/login` | Получить URL авторизации + sessionId |
| GET | `/auth/callback` | Колбэк от SoundCloud (автоматически) |
| GET | `/auth/session` | Статус сессии |
| POST | `/auth/refresh` | Обновить токен |
| POST | `/auth/logout` | Выйти |

Все остальные эндпоинты требуют хедер `x-session-id` с sessionId, полученным при логине.

---

## 6. API — покрытие SoundCloud

### Me (текущий пользователь)
`GET /me` · `/me/feed` · `/me/feed/tracks` · `/me/likes/tracks` · `/me/likes/playlists` · `/me/followings` · `/me/followings/tracks` · `/me/followers` · `/me/playlists` · `/me/tracks`
`PUT /me/followings/:userUrn` · `DELETE /me/followings/:userUrn`

### Tracks
`GET /tracks` — поиск · `GET /tracks/:id` · `PUT /tracks/:id` · `DELETE /tracks/:id`
`GET /tracks/:id/streams` · `/tracks/:id/comments` · `/tracks/:id/favoriters` · `/tracks/:id/reposters` · `/tracks/:id/related`
`POST /tracks/:id/comments`

### Playlists
`GET /playlists` — поиск · `POST /playlists` · `GET /playlists/:id` · `PUT /playlists/:id` · `DELETE /playlists/:id`
`GET /playlists/:id/tracks` · `/playlists/:id/reposters`

### Users
`GET /users` — поиск · `GET /users/:id` · `/users/:id/followers` · `/users/:id/followings` · `/users/:id/tracks` · `/users/:id/playlists` · `/users/:id/likes/tracks` · `/users/:id/likes/playlists` · `/users/:id/web-profiles`

### Likes
`POST /likes/tracks/:id` · `DELETE /likes/tracks/:id`
`POST /likes/playlists/:id` · `DELETE /likes/playlists/:id`

### Reposts
`POST /reposts/tracks/:id` · `DELETE /reposts/tracks/:id`
`POST /reposts/playlists/:id` · `DELETE /reposts/playlists/:id`

### Resolve
`GET /resolve?url=...` — резолв SoundCloud URL в ресурс

---

## 7. Структура проекта

```
src/
├── main.ts                     # Bootstrap, Swagger setup
├── app.module.ts               # Root module
├── config/configuration.ts     # Env-based конфиг
├── auth/                       # OAuth 2.1 + PKCE, сессии
│   ├── entities/session.entity.ts
│   ├── callback-page.ts        # Glass UI страница колбэка
│   └── ...
├── soundcloud/                 # HTTP-клиент к SC API + типы
├── me/                         # /me/*
├── tracks/                     # /tracks/*
├── playlists/                  # /playlists/*
├── users/                      # /users/*
├── likes/                      # /likes/*
├── reposts/                    # /reposts/*
├── resolve/                    # /resolve
├── health/                     # /health
└── common/
    ├── guards/auth.guard.ts    # Проверка x-session-id
    ├── decorators/             # @AccessToken()
    └── dto/pagination.dto.ts   # Пагинация
```

---

## 8. Скрипты

```bash
pnpm start:dev      # Dev с hot-reload
pnpm build          # Сборка
pnpm start:prod     # Запуск собранного
pnpm lint           # Biome lint
pnpm format         # Biome format
pnpm check          # Biome lint + format
pnpm test           # Unit-тесты
pnpm test:e2e       # E2E-тесты
```
