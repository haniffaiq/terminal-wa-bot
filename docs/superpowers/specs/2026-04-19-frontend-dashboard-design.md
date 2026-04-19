# Frontend Dashboard & Docker Restructure — Design Spec

## Overview

Add a frontend dashboard to terminal-wa-bot and restructure the project into `/backend` and `/frontend` directories, runnable via Docker Compose.

## Decisions

| Decision | Choice |
|----------|--------|
| Frontend framework | React + Vite + TypeScript |
| UI library | Tailwind CSS + shadcn/ui |
| Realtime communication | Socket.io (WebSocket) |
| Authentication | Basic Auth (same credentials as API) |
| Docker setup | 2 containers: backend (Node) + frontend (Nginx) |
| Log viewer | Refresh-based, not realtime |

## Project Structure

```
terminal-wa-bot/
├── backend/
│   ├── index.js              # Express app + socket.io server
│   ├── bots/
│   │   ├── adminBot.js
│   │   ├── operationBot.js
│   │   ├── hertbeat.js
│   │   └── proxyConfig.js
│   ├── utils/
│   │   ├── createSock.js
│   │   ├── midleware.js
│   │   └── statmanager.js
│   ├── data/                 # runtime data (mounted volume)
│   ├── logs/
│   ├── stats/
│   ├── uploads/
│   ├── auth_sessions/
│   ├── package.json
│   └── Dockerfile
├── frontend/
│   ├── src/
│   │   ├── App.tsx
│   │   ├── main.tsx
│   │   ├── components/
│   │   │   └── ui/           # shadcn components
│   │   ├── pages/
│   │   │   ├── Dashboard.tsx
│   │   │   ├── BotManagement.tsx
│   │   │   ├── SendMessage.tsx
│   │   │   ├── Groups.tsx
│   │   │   ├── FailedRequests.tsx
│   │   │   ├── Statistics.tsx
│   │   │   └── Logs.tsx
│   │   ├── lib/
│   │   │   ├── api.ts
│   │   │   └── socket.ts
│   │   └── hooks/
│   │       └── useSocket.ts
│   ├── package.json
│   ├── vite.config.ts
│   ├── tailwind.config.js
│   └── Dockerfile            # multi-stage: build → nginx serve
├── docker-compose.yml
└── CLAUDE.md
```

## Backend Changes

### File Migration

All existing files move into `/backend` as-is. Internal relative imports (`./bots/`, `./utils/`) remain unchanged.

### New Dependencies

- `socket.io` — WebSocket server for realtime bot status and QR code push

### API Prefix

All existing endpoints get `/api` prefix:

| Old | New |
|-----|-----|
| `POST /send-message` | `POST /api/send-message` |
| `POST /send-media` | `POST /api/send-media` |
| `POST /send-media-from-url` | `POST /api/send-media-from-url` |
| `POST /addbot` | `POST /api/addbot` |
| `POST /restart` | `POST /api/restart` |
| `POST /disconnect` | `POST /api/disconnect` |
| `GET /bot-status` | `GET /api/bot-status` |
| `GET /list-my-groups` | `GET /api/list-my-groups` |
| `POST /resend-failed` | `POST /api/resend-failed` |
| `POST /hi` | `POST /api/hi` |

### New Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/stats/:date` | Get stats JSON for a specific date |
| `GET` | `/api/logs/:type/:date` | Read log file content (paginated) |
| `GET` | `/api/groups` | List all groups from all active bots |
| `POST` | `/api/groups/block` | Block a group by ID |
| `POST` | `/api/groups/unblock` | Unblock a group by ID |

### Socket.io Events

```
Backend → Frontend:
  bot:status    { botId, status, timestamp }     — bot connect/disconnect
  bot:qr        { botId, qr: base64string }      — QR code for new bot
  bot:connected { botId }                         — bot successfully logged in

Frontend → Backend:
  bot:add       { botId }                         — request to create new bot
```

### CORS

Enable CORS for development (frontend dev server at port 5173).

## Frontend Design

### Authentication

- Login page: username + password form
- Test credentials via `GET /api/bot-status` — 200 = success, 401 = fail
- Credentials stored in memory (not localStorage)
- Every API call includes `Authorization: Basic base64(user:pass)` header
- Socket.io sends auth in handshake query

### API Client (`lib/api.ts`)

Single `fetchWithAuth(url, options)` wrapper that auto-injects Basic Auth header. Base URL configurable via `VITE_API_URL` env variable (default: `/api` in production, `http://localhost:8008/api` in dev).

### Socket Client (`lib/socket.ts`)

Socket.io client that connects with auth credentials. Exports singleton instance.

### React Hook (`hooks/useSocket.ts`)

Hook that subscribes to socket events and returns current state. Used by Dashboard and BotManagement pages.

### Pages

#### Dashboard (home)
- Card grid: each bot as a card — name, online/offline badge, uptime, messages today
- Summary stats: total messages today, total active bots, total groups, total failed
- Bot status updates realtime via socket.io

#### Bot Management
- Table of all bots with status and action buttons (restart, disconnect)
- Add Bot: click button → modal → input bot ID → QR appears via socket.io → user scans → status updates to connected → modal closes
- QR auto-refreshes on expiry

#### Send Message
- Form: select groups (multi-select), message type (text/image/document), input text/upload file/paste URL
- Preview before sending
- Shows transaction ID and per-group status in response

#### Groups
- Table: group name, group ID, registered bots, blocked/active status
- Block/unblock action buttons
- Search and filter

#### Failed Requests
- Table: transaction ID, timestamp, target group, error, status
- Retry individual or retry all
- Auto-refresh after retry

#### Statistics
- Date picker
- Bar chart: messages per hour per bot (using recharts)
- Summary: total messages per bot per day

#### Logs
- Dropdown: log type (success/error/warn/req-res) + date
- Log content in scrollable monospace container
- Manual refresh button (no realtime)

### Navigation

Sidebar with links to all 7 pages. Collapsible on mobile.

## Docker Compose

```yaml
services:
  backend:
    build: ./backend
    ports:
      - "8008:8008"
    volumes:
      - ./backend/auth_sessions:/app/auth_sessions
      - ./backend/data:/app/data
      - ./backend/logs:/app/logs
      - ./backend/stats:/app/stats
      - ./backend/uploads:/app/uploads
    environment:
      - NODE_ENV=production

  frontend:
    build: ./frontend
    ports:
      - "3000:80"
    depends_on:
      - backend
```

### Backend Dockerfile

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY . .
EXPOSE 8008
CMD ["node", "index.js"]
```

### Frontend Dockerfile (multi-stage)

```dockerfile
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
```

### Frontend Nginx Config

```nginx
server {
    listen 80;

    location /api/ {
        proxy_pass http://backend:8008/api/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    location /socket.io/ {
        proxy_pass http://backend:8008/socket.io/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }

    location / {
        root /usr/share/nginx/html;
        index index.html;
        try_files $uri $uri/ /index.html;
    }
}
```
