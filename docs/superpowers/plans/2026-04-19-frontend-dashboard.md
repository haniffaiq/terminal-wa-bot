# Frontend Dashboard & Docker Restructure — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a React frontend dashboard to the WhatsApp bot project, restructure into /backend and /frontend directories, and make it runnable via Docker Compose.

**Architecture:** Express backend with socket.io moves to /backend. New React+Vite frontend in /frontend with Tailwind+shadcn/ui. Two Docker containers: backend (Node) and frontend (multi-stage Nginx). Nginx proxies /api and /socket.io to the backend container.

**Tech Stack:** Node.js, Express, socket.io, React, Vite, TypeScript, Tailwind CSS, shadcn/ui, recharts, Docker, Nginx

---

## File Structure

### Backend (moved + modified)
- Move: all existing files → `backend/`
- Modify: `backend/index.js` — add socket.io, prefix all routes with `/api`, add new endpoints, enable CORS
- Modify: `backend/package.json` — add `socket.io`, `cors`, `mime-types` (already used but not in deps)
- Create: `backend/Dockerfile`
- Create: `backend/.dockerignore`

### Frontend (all new)
- Create: `frontend/package.json`
- Create: `frontend/vite.config.ts`
- Create: `frontend/tsconfig.json`
- Create: `frontend/tsconfig.app.json`
- Create: `frontend/tailwind.config.js`
- Create: `frontend/postcss.config.js`
- Create: `frontend/index.html`
- Create: `frontend/src/main.tsx`
- Create: `frontend/src/App.tsx`
- Create: `frontend/src/index.css`
- Create: `frontend/src/lib/api.ts`
- Create: `frontend/src/lib/socket.ts`
- Create: `frontend/src/lib/auth.ts`
- Create: `frontend/src/hooks/useSocket.ts`
- Create: `frontend/src/components/Layout.tsx`
- Create: `frontend/src/components/Login.tsx`
- Create: `frontend/src/components/ProtectedRoute.tsx`
- Create: `frontend/src/pages/Dashboard.tsx`
- Create: `frontend/src/pages/BotManagement.tsx`
- Create: `frontend/src/pages/SendMessage.tsx`
- Create: `frontend/src/pages/Groups.tsx`
- Create: `frontend/src/pages/FailedRequests.tsx`
- Create: `frontend/src/pages/Statistics.tsx`
- Create: `frontend/src/pages/Logs.tsx`
- Create: `frontend/Dockerfile`
- Create: `frontend/.dockerignore`
- Create: `frontend/nginx.conf`

### Root
- Create: `docker-compose.yml`
- Modify: `CLAUDE.md` — update for new structure
- Modify: `.gitignore` — add `frontend/node_modules`, `frontend/dist`

---

### Task 1: Restructure — Move Backend Files

**Files:**
- Move: all root-level source files → `backend/`
- Modify: `.gitignore`

- [ ] **Step 1: Create backend directory and move files**

```bash
mkdir -p backend
# Move source files
mv index.js backend/
mv package.json backend/
mv package-lock.json backend/ 2>/dev/null || true
mv bots/ backend/
mv utils/ backend/
# Move data directories
mv blocked.json backend/ 2>/dev/null || true
mv failed_requests.json backend/ 2>/dev/null || true
# Move runtime directories (create if missing)
mv auth_sessions/ backend/ 2>/dev/null || mkdir -p backend/auth_sessions
mv data/ backend/ 2>/dev/null || mkdir -p backend/data
mv logs/ backend/ 2>/dev/null || mkdir -p backend/logs
mv stats/ backend/ 2>/dev/null || mkdir -p backend/stats
mv uploads/ backend/ 2>/dev/null || mkdir -p backend/uploads
```

- [ ] **Step 2: Update .gitignore for new structure**

Add to `.gitignore`:
```
# Backend
backend/node_modules/
backend/auth_sessions/
backend/logs/
backend/stats/
backend/uploads/
backend/data/
backend/blocked.json
backend/failed_requests.json

# Frontend
frontend/node_modules/
frontend/dist/
```

- [ ] **Step 3: Verify backend still works**

```bash
cd backend && npm install && node -e "require('./index.js'); setTimeout(() => process.exit(0), 3000)"
```

Expected: Server starts on port 8008 without errors (may warn about proxy config).

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor: restructure project — move all source files to /backend"
```

---

### Task 2: Backend — Add Socket.io, API Prefix, CORS, New Endpoints

**Files:**
- Modify: `backend/package.json` — add dependencies
- Modify: `backend/index.js` — socket.io, /api prefix, CORS, new endpoints

- [ ] **Step 1: Install new backend dependencies**

```bash
cd backend && npm install socket.io cors
```

- [ ] **Step 2: Modify backend/index.js — add socket.io and CORS setup**

Replace the Express app creation and server startup. At the top of `backend/index.js`, after the existing requires, add:

```javascript
const cors = require('cors');
const { createServer } = require('http');
const { Server } = require('socket.io');
```

Replace the existing:
```javascript
const app = express();
```
with:
```javascript
const app = express();
const server = createServer(app);
const io = new Server(server, {
    cors: {
        origin: process.env.NODE_ENV === 'production' ? false : ['http://localhost:5173'],
        credentials: true
    }
});
```

After `app.use(express.json());`, before `app.use(midleware);`, add:
```javascript
app.use(cors({
    origin: process.env.NODE_ENV === 'production' ? false : ['http://localhost:5173'],
    credentials: true
}));
```

Remove the old commented-out CORS block (lines ~27-30 in original).

- [ ] **Step 3: Prefix all existing routes with /api**

Find and replace each route:
- `app.post('/hi'` → `app.post('/api/hi'`
- `app.post('/resend-failed'` → `app.post('/api/resend-failed'`
- `app.post('/send-message'` → `app.post('/api/send-message'`
- `app.post('/disconnect'` → `app.post('/api/disconnect'`
- `app.post('/addbot'` → `app.post('/api/addbot'`
- `app.post('/restart'` → `app.post('/api/restart'`
- `app.get('/bot-status'` → `app.get('/api/bot-status'`
- `app.post('/send-media',` → `app.post('/api/send-media',`
- `app.post('/send-media-from-url'` → `app.post('/api/send-media-from-url'`
- `app.get('/list-my-groups'` → `app.get('/api/list-my-groups'`

Also update the `failedRequestsFile` path and multer destination to use `__dirname` properly:
- `'./uploads/'` in multer destination → `path.join(__dirname, 'uploads')`
- Make sure `blocked.json` reads use `path.join(__dirname, 'blocked.json')`

- [ ] **Step 4: Add new API endpoints before the server.listen call**

Add these endpoints in `backend/index.js`, before the `PORT` / `listen` section:

```javascript
// GET /api/stats/:date — get stats for a specific date
app.get('/api/stats/:date', (req, res) => {
    const { date } = req.params; // format: YYYY-MM-DD
    const statsFile = path.join(__dirname, 'stats', `stats-${date}.json`);

    if (!fs.existsSync(statsFile)) {
        return res.status(404).json({ error: 'Stats not found for this date' });
    }

    try {
        const data = JSON.parse(fs.readFileSync(statsFile, 'utf-8'));
        res.json({ success: true, date, data });
    } catch (err) {
        res.status(500).json({ error: 'Failed to read stats file' });
    }
});

// GET /api/logs/:type/:date — read log file content
app.get('/api/logs/:type/:date', (req, res) => {
    const { type, date } = req.params;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 100;

    const logFileMap = {
        'success': `success-wa-history-${date}.log`,
        'error': `error-wa-${date}.log`,
        'warn': `warn-wa-history-${date}.log`,
        'req-res': `req-res-${date}.log`
    };

    const fileName = logFileMap[type];
    if (!fileName) {
        return res.status(400).json({ error: 'Invalid log type. Use: success, error, warn, req-res' });
    }

    const logFile = path.join(__dirname, 'logs', fileName);
    if (!fs.existsSync(logFile)) {
        return res.status(404).json({ error: 'Log file not found' });
    }

    try {
        const content = fs.readFileSync(logFile, 'utf-8');
        const lines = content.split('\n').filter(l => l.trim());
        const totalLines = lines.length;
        const start = (page - 1) * limit;
        const paginatedLines = lines.slice(start, start + limit);

        res.json({
            success: true,
            type,
            date,
            page,
            limit,
            totalLines,
            totalPages: Math.ceil(totalLines / limit),
            lines: paginatedLines
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to read log file' });
    }
});

// GET /api/groups — list all groups from all active bots
app.get('/api/groups', async (req, res) => {
    try {
        const dummyGroupId = '120363419686014131@g.us';
        const sock = getNextBotForGroup(dummyGroupId);

        if (!sock) {
            return res.status(400).json({ success: false, error: 'No active bot available' });
        }

        const groups = Object.values(await sock.groupFetchAllParticipating());
        const blockedList = getBlockedList();

        res.json({
            success: true,
            group_count: groups.length,
            groups: groups.map(g => ({
                id: g.id,
                name: g.subject,
                member_count: g.participants.length,
                is_blocked: blockedList.includes(g.id)
            }))
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST /api/groups/block — block a group
app.post('/api/groups/block', (req, res) => {
    const { groupId } = req.body;
    if (!groupId) return res.status(400).json({ error: 'groupId required' });

    const blockedFile = path.join(__dirname, 'blocked.json');
    let blockedList = [];
    try {
        blockedList = JSON.parse(fs.readFileSync(blockedFile, 'utf-8'));
    } catch (e) { blockedList = []; }

    if (blockedList.includes(groupId)) {
        return res.json({ success: true, message: 'Already blocked' });
    }

    blockedList.push(groupId);
    fs.writeFileSync(blockedFile, JSON.stringify(blockedList, null, 2));
    res.json({ success: true, message: `Group ${groupId} blocked` });
});

// POST /api/groups/unblock — unblock a group
app.post('/api/groups/unblock', (req, res) => {
    const { groupId } = req.body;
    if (!groupId) return res.status(400).json({ error: 'groupId required' });

    const blockedFile = path.join(__dirname, 'blocked.json');
    let blockedList = [];
    try {
        blockedList = JSON.parse(fs.readFileSync(blockedFile, 'utf-8'));
    } catch (e) { blockedList = []; }

    blockedList = blockedList.filter(id => id !== groupId);
    fs.writeFileSync(blockedFile, JSON.stringify(blockedList, null, 2));
    res.json({ success: true, message: `Group ${groupId} unblocked` });
});

// GET /api/failed-requests — list failed requests
app.get('/api/failed-requests', (req, res) => {
    const failedFile = path.join(__dirname, 'failed_requests.json');
    try {
        if (!fs.existsSync(failedFile)) {
            return res.json({ success: true, data: [] });
        }
        const data = JSON.parse(fs.readFileSync(failedFile, 'utf-8'));
        res.json({ success: true, data });
    } catch (err) {
        res.status(500).json({ error: 'Failed to read failed requests' });
    }
});
```

- [ ] **Step 5: Add socket.io event handling and change app.listen to server.listen**

Add socket.io auth and event handling before the `server.listen` call:

```javascript
// Socket.io authentication
io.use((socket, next) => {
    const auth = socket.handshake.auth;
    if (auth && auth.username === 'wa-ops' && auth.password === 'wapass@2021') {
        next();
    } else {
        next(new Error('Authentication failed'));
    }
});

io.on('connection', (socket) => {
    logger('info', `Dashboard client connected: ${socket.id}`);

    socket.on('bot:add', async ({ botId }) => {
        if (!botId) return;
        logger('info', `[Socket] Adding bot: ${botId}`);
        const qrBase64 = await startOperationBotAPI(botId);
        if (qrBase64) {
            socket.emit('bot:qr', { botId, qr: qrBase64 });
        }
    });

    socket.on('disconnect', () => {
        logger('info', `Dashboard client disconnected: ${socket.id}`);
    });
});

// Export io so other modules can emit events
module.exports = { io };
```

Replace the existing:
```javascript
app.listen(PORT, () => {
    logger('info', `API berjalan di port ${PORT}`);
});
```
with:
```javascript
server.listen(PORT, () => {
    logger('info', `API berjalan di port ${PORT}`);
});
```

- [ ] **Step 6: Add socket.io emit to heartbeat and bot status updates**

Modify `backend/utils/createSock.js` — add socket emit on status change. At the end of `updateBotStatus` function, after writing the file, add:

```javascript
    // Emit to dashboard if io is available
    try {
        const { io } = require('../index');
        if (io) {
            io.emit('bot:status', { botId, status, timestamp: new Date().toISOString() });
        }
    } catch (e) {
        // io not ready yet during startup, ignore
    }
```

- [ ] **Step 7: Verify backend changes**

```bash
cd backend && node -e "
const express = require('express');
const cors = require('cors');
const { createServer } = require('http');
const { Server } = require('socket.io');
console.log('All dependencies loaded OK');
process.exit(0);
"
```

Expected: "All dependencies loaded OK"

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: add socket.io, CORS, /api prefix, and new endpoints to backend"
```

---

### Task 3: Frontend — Scaffold React + Vite + Tailwind + shadcn/ui

**Files:**
- Create: `frontend/` with Vite React TypeScript project
- Install: Tailwind CSS, shadcn/ui, react-router-dom, socket.io-client, recharts, lucide-react

- [ ] **Step 1: Create Vite project**

```bash
cd /Users/HanifHDD/ownership/portofolio/tools/terminal-wa-bot
npm create vite@latest frontend -- --template react-ts
```

- [ ] **Step 2: Install dependencies**

```bash
cd frontend
npm install
npm install react-router-dom socket.io-client recharts lucide-react
npm install -D tailwindcss @tailwindcss/vite
```

- [ ] **Step 3: Configure Tailwind**

Replace `frontend/src/index.css` with:
```css
@import "tailwindcss";
```

Add Tailwind Vite plugin to `frontend/vite.config.ts`:
```typescript
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8008',
        changeOrigin: true,
      },
      '/socket.io': {
        target: 'http://localhost:8008',
        ws: true,
      },
    },
  },
})
```

- [ ] **Step 4: Setup shadcn/ui**

```bash
cd frontend
npx shadcn@latest init -d
```

When prompted, accept defaults. This creates `components.json` and `src/components/ui/`.

Then install the components we need:
```bash
npx shadcn@latest add button card input label table badge dialog select textarea tabs separator
```

- [ ] **Step 5: Update tsconfig for path aliases**

Ensure `frontend/tsconfig.json` has:
```json
{
  "files": [],
  "references": [
    { "path": "./tsconfig.app.json" },
    { "path": "./tsconfig.node.json" }
  ],
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      "@/*": ["./src/*"]
    }
  }
}
```

And `frontend/tsconfig.app.json` has in compilerOptions:
```json
"baseUrl": ".",
"paths": {
  "@/*": ["./src/*"]
}
```

- [ ] **Step 6: Verify frontend dev server starts**

```bash
cd frontend && npm run dev -- --host 2>&1 &
sleep 3
curl -s http://localhost:5173 | head -5
kill %1
```

Expected: HTML output containing `<div id="root">`.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: scaffold frontend with React, Vite, Tailwind, shadcn/ui"
```

---

### Task 4: Frontend — Auth, API Client, Socket Client

**Files:**
- Create: `frontend/src/lib/auth.ts`
- Create: `frontend/src/lib/api.ts`
- Create: `frontend/src/lib/socket.ts`
- Create: `frontend/src/hooks/useSocket.ts`

- [ ] **Step 1: Create auth module**

Create `frontend/src/lib/auth.ts`:
```typescript
let credentials: { username: string; password: string } | null = null;

export function setCredentials(username: string, password: string) {
  credentials = { username, password };
}

export function getCredentials() {
  return credentials;
}

export function clearCredentials() {
  credentials = null;
}

export function getAuthHeader(): string | null {
  if (!credentials) return null;
  return 'Basic ' + btoa(`${credentials.username}:${credentials.password}`);
}

export function isAuthenticated(): boolean {
  return credentials !== null;
}
```

- [ ] **Step 2: Create API client**

Create `frontend/src/lib/api.ts`:
```typescript
import { getAuthHeader, clearCredentials } from './auth';

const BASE_URL = '/api';

export async function fetchApi<T = unknown>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const authHeader = getAuthHeader();
  if (!authHeader) {
    throw new Error('Not authenticated');
  }

  const res = await fetch(`${BASE_URL}${endpoint}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: authHeader,
      ...options.headers,
    },
  });

  if (res.status === 401) {
    clearCredentials();
    window.location.reload();
    throw new Error('Unauthorized');
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }

  return res.json();
}

export async function postApi<T = unknown>(
  endpoint: string,
  body: unknown
): Promise<T> {
  return fetchApi<T>(endpoint, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function uploadFile(
  endpoint: string,
  formData: FormData
): Promise<unknown> {
  const authHeader = getAuthHeader();
  if (!authHeader) throw new Error('Not authenticated');

  const res = await fetch(`${BASE_URL}${endpoint}`, {
    method: 'POST',
    headers: { Authorization: authHeader },
    body: formData,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }

  return res.json();
}
```

- [ ] **Step 3: Create socket client**

Create `frontend/src/lib/socket.ts`:
```typescript
import { io, Socket } from 'socket.io-client';
import { getCredentials } from './auth';

let socket: Socket | null = null;

export function getSocket(): Socket {
  if (socket) return socket;

  const creds = getCredentials();

  socket = io({
    auth: {
      username: creds?.username,
      password: creds?.password,
    },
    transports: ['websocket'],
  });

  return socket;
}

export function disconnectSocket() {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}
```

- [ ] **Step 4: Create useSocket hook**

Create `frontend/src/hooks/useSocket.ts`:
```typescript
import { useEffect, useState } from 'react';
import { getSocket } from '@/lib/socket';

interface BotStatus {
  botId: string;
  status: string;
  timestamp: string;
}

export function useSocket() {
  const [botStatuses, setBotStatuses] = useState<Map<string, BotStatus>>(new Map());
  const [qrCode, setQrCode] = useState<{ botId: string; qr: string } | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const socket = getSocket();

    socket.on('connect', () => setConnected(true));
    socket.on('disconnect', () => setConnected(false));

    socket.on('bot:status', (data: BotStatus) => {
      setBotStatuses(prev => {
        const next = new Map(prev);
        next.set(data.botId, data);
        return next;
      });
    });

    socket.on('bot:qr', (data: { botId: string; qr: string }) => {
      setQrCode(data);
    });

    socket.on('bot:connected', (data: { botId: string }) => {
      setQrCode(null);
      setBotStatuses(prev => {
        const next = new Map(prev);
        next.set(data.botId, { botId: data.botId, status: 'open', timestamp: new Date().toISOString() });
        return next;
      });
    });

    return () => {
      socket.off('connect');
      socket.off('disconnect');
      socket.off('bot:status');
      socket.off('bot:qr');
      socket.off('bot:connected');
    };
  }, []);

  return { botStatuses, qrCode, connected, setQrCode };
}
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add auth, API client, socket client, and useSocket hook"
```

---

### Task 5: Frontend — Login and Layout

**Files:**
- Create: `frontend/src/components/Login.tsx`
- Create: `frontend/src/components/Layout.tsx`
- Create: `frontend/src/components/ProtectedRoute.tsx`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/main.tsx`

- [ ] **Step 1: Create Login component**

Create `frontend/src/components/Login.tsx`:
```tsx
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { setCredentials, getAuthHeader } from '@/lib/auth';

export function Login({ onLogin }: { onLogin: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');

    setCredentials(username, password);

    try {
      const res = await fetch('/api/bot-status', {
        headers: { Authorization: getAuthHeader()! },
      });

      if (res.ok) {
        onLogin();
      } else {
        setError('Invalid credentials');
        setCredentials('', '');
      }
    } catch {
      setError('Connection failed');
      setCredentials('', '');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-center">WA Bot Dashboard</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="username">Username</Label>
              <Input
                id="username"
                value={username}
                onChange={e => setUsername(e.target.value)}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                required
              />
            </div>
            {error && <p className="text-sm text-red-500">{error}</p>}
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? 'Logging in...' : 'Login'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
```

- [ ] **Step 2: Create Layout component with sidebar navigation**

Create `frontend/src/components/Layout.tsx`:
```tsx
import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import {
  LayoutDashboard,
  Bot,
  Send,
  Users,
  AlertTriangle,
  BarChart3,
  FileText,
  LogOut,
  Menu,
  X,
} from 'lucide-react';
import { clearCredentials } from '@/lib/auth';
import { disconnectSocket } from '@/lib/socket';

const navItems = [
  { path: '/', label: 'Dashboard', icon: LayoutDashboard },
  { path: '/bots', label: 'Bot Management', icon: Bot },
  { path: '/send', label: 'Send Message', icon: Send },
  { path: '/groups', label: 'Groups', icon: Users },
  { path: '/failed', label: 'Failed Requests', icon: AlertTriangle },
  { path: '/stats', label: 'Statistics', icon: BarChart3 },
  { path: '/logs', label: 'Logs', icon: FileText },
];

export function Layout({ children, onLogout }: { children: React.ReactNode; onLogout: () => void }) {
  const location = useLocation();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  function handleLogout() {
    clearCredentials();
    disconnectSocket();
    onLogout();
  }

  return (
    <div className="flex h-screen bg-gray-100">
      {/* Mobile overlay */}
      {sidebarOpen && (
        <div className="fixed inset-0 z-20 bg-black/50 lg:hidden" onClick={() => setSidebarOpen(false)} />
      )}

      {/* Sidebar */}
      <aside className={`
        fixed inset-y-0 left-0 z-30 w-64 bg-white border-r transform transition-transform lg:relative lg:translate-x-0
        ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}
      `}>
        <div className="flex items-center justify-between h-16 px-4 border-b">
          <h1 className="text-lg font-bold">WA Bot</h1>
          <Button variant="ghost" size="icon" className="lg:hidden" onClick={() => setSidebarOpen(false)}>
            <X className="h-5 w-5" />
          </Button>
        </div>
        <nav className="p-4 space-y-1">
          {navItems.map(item => (
            <Link
              key={item.path}
              to={item.path}
              onClick={() => setSidebarOpen(false)}
              className={`flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors ${
                location.pathname === item.path
                  ? 'bg-gray-100 text-gray-900 font-medium'
                  : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'
              }`}
            >
              <item.icon className="h-4 w-4" />
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="absolute bottom-0 w-full p-4 border-t">
          <Button variant="ghost" className="w-full justify-start gap-3 text-gray-600" onClick={handleLogout}>
            <LogOut className="h-4 w-4" />
            Logout
          </Button>
        </div>
      </aside>

      {/* Main content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <header className="h-16 bg-white border-b flex items-center px-4 lg:hidden">
          <Button variant="ghost" size="icon" onClick={() => setSidebarOpen(true)}>
            <Menu className="h-5 w-5" />
          </Button>
        </header>
        <main className="flex-1 overflow-y-auto p-6">
          {children}
        </main>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Create ProtectedRoute component**

Create `frontend/src/components/ProtectedRoute.tsx`:
```tsx
import { isAuthenticated } from '@/lib/auth';
import { Login } from './Login';

export function ProtectedRoute({
  children,
  onLogin,
}: {
  children: React.ReactNode;
  onLogin: () => void;
}) {
  if (!isAuthenticated()) {
    return <Login onLogin={onLogin} />;
  }
  return <>{children}</>;
}
```

- [ ] **Step 4: Create App.tsx with routing**

Replace `frontend/src/App.tsx`:
```tsx
import { useState } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { ProtectedRoute } from '@/components/ProtectedRoute';
import { Layout } from '@/components/Layout';
import Dashboard from '@/pages/Dashboard';
import BotManagement from '@/pages/BotManagement';
import SendMessage from '@/pages/SendMessage';
import Groups from '@/pages/Groups';
import FailedRequests from '@/pages/FailedRequests';
import Statistics from '@/pages/Statistics';
import Logs from '@/pages/Logs';

export default function App() {
  const [, setAuthed] = useState(false);

  return (
    <BrowserRouter>
      <ProtectedRoute onLogin={() => setAuthed(true)}>
        <Layout onLogout={() => setAuthed(false)}>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/bots" element={<BotManagement />} />
            <Route path="/send" element={<SendMessage />} />
            <Route path="/groups" element={<Groups />} />
            <Route path="/failed" element={<FailedRequests />} />
            <Route path="/stats" element={<Statistics />} />
            <Route path="/logs" element={<Logs />} />
          </Routes>
        </Layout>
      </ProtectedRoute>
    </BrowserRouter>
  );
}
```

- [ ] **Step 5: Update main.tsx**

Replace `frontend/src/main.tsx`:
```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
```

- [ ] **Step 6: Create placeholder pages**

Create each page file with a minimal placeholder so the app compiles:

`frontend/src/pages/Dashboard.tsx`:
```tsx
export default function Dashboard() {
  return <div><h1 className="text-2xl font-bold">Dashboard</h1></div>;
}
```

Create the same pattern for all other pages: `BotManagement.tsx`, `SendMessage.tsx`, `Groups.tsx`, `FailedRequests.tsx`, `Statistics.tsx`, `Logs.tsx` — each with just a heading matching the page name.

- [ ] **Step 7: Remove unused default Vite files**

```bash
rm -f frontend/src/App.css frontend/src/assets/react.svg frontend/public/vite.svg
```

- [ ] **Step 8: Verify the app compiles and renders**

```bash
cd frontend && npm run build
```

Expected: Build succeeds with output in `dist/`.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat: add login, layout with sidebar navigation, and routing"
```

---

### Task 6: Frontend — Dashboard Page

**Files:**
- Modify: `frontend/src/pages/Dashboard.tsx`

- [ ] **Step 1: Implement Dashboard page**

Replace `frontend/src/pages/Dashboard.tsx`:
```tsx
import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { fetchApi } from '@/lib/api';
import { useSocket } from '@/hooks/useSocket';
import { Bot, Users, AlertTriangle, MessageSquare } from 'lucide-react';

interface BotStatusResponse {
  success: boolean;
  data: { active: string[]; inactive: string[] };
}

interface StatsData {
  [hour: string]: { [bot: string]: number };
}

export default function Dashboard() {
  const [botData, setBotData] = useState<BotStatusResponse | null>(null);
  const [todayStats, setTodayStats] = useState<StatsData>({});
  const [failedCount, setFailedCount] = useState(0);
  const [groupCount, setGroupCount] = useState(0);
  const { botStatuses } = useSocket();

  useEffect(() => {
    loadData();
  }, []);

  async function loadData() {
    try {
      const [status, failed, groups] = await Promise.all([
        fetchApi<BotStatusResponse>('/bot-status'),
        fetchApi<{ success: boolean; data: unknown[] }>('/failed-requests'),
        fetchApi<{ success: boolean; group_count: number }>('/groups').catch(() => ({ success: false, group_count: 0 })),
      ]);
      setBotData(status);
      setFailedCount(failed.data?.length || 0);
      setGroupCount(groups.group_count || 0);

      const today = new Date().toISOString().split('T')[0];
      const stats = await fetchApi<{ success: boolean; data: StatsData }>(`/stats/${today}`).catch(() => ({ success: false, data: {} }));
      setTodayStats(stats.data || {});
    } catch (err) {
      console.error('Failed to load dashboard data:', err);
    }
  }

  const totalMessagesToday = Object.values(todayStats).reduce((sum, hour) => {
    return sum + Object.values(hour).reduce((s, v) => s + v, 0);
  }, 0);

  const activeBots = botData?.data?.active || [];
  const inactiveBots = botData?.data?.inactive || [];

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Dashboard</h1>

      {/* Summary cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-gray-500">Active Bots</CardTitle>
            <Bot className="h-4 w-4 text-gray-400" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{activeBots.length}</div>
            <p className="text-xs text-gray-500">{inactiveBots.length} inactive</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-gray-500">Messages Today</CardTitle>
            <MessageSquare className="h-4 w-4 text-gray-400" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{totalMessagesToday}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-gray-500">Total Groups</CardTitle>
            <Users className="h-4 w-4 text-gray-400" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{groupCount}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-gray-500">Failed Requests</CardTitle>
            <AlertTriangle className="h-4 w-4 text-gray-400" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-red-600">{failedCount}</div>
          </CardContent>
        </Card>
      </div>

      {/* Bot status cards */}
      <h2 className="text-lg font-semibold">Bot Status</h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {[...activeBots, ...inactiveBots].map(botId => {
          const realtimeStatus = botStatuses.get(botId);
          const isOnline = realtimeStatus
            ? realtimeStatus.status === 'open'
            : activeBots.includes(botId);

          // Count messages for this bot today
          const botMessages = Object.values(todayStats).reduce((sum, hour) => {
            return sum + (hour[botId.split('_')[0]] || 0);
          }, 0);

          return (
            <Card key={botId}>
              <CardContent className="pt-6">
                <div className="flex items-center justify-between">
                  <span className="font-medium">{botId}</span>
                  <Badge variant={isOnline ? 'default' : 'destructive'}>
                    {isOnline ? 'Online' : 'Offline'}
                  </Badge>
                </div>
                <p className="text-sm text-gray-500 mt-2">
                  Messages today: {botMessages}
                </p>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify build**

```bash
cd frontend && npm run build
```

Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat: implement Dashboard page with bot status and stats"
```

---

### Task 7: Frontend — Bot Management Page

**Files:**
- Modify: `frontend/src/pages/BotManagement.tsx`

- [ ] **Step 1: Implement Bot Management page**

Replace `frontend/src/pages/BotManagement.tsx`:
```tsx
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { fetchApi, postApi } from '@/lib/api';
import { useSocket } from '@/hooks/useSocket';
import { getSocket } from '@/lib/socket';
import { Plus, RotateCcw, Power } from 'lucide-react';

interface BotStatusResponse {
  success: boolean;
  data: { active: string[]; inactive: string[] };
}

export default function BotManagement() {
  const [botData, setBotData] = useState<BotStatusResponse | null>(null);
  const [newBotId, setNewBotId] = useState('');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [loading, setLoading] = useState<string | null>(null);
  const { botStatuses, qrCode, setQrCode } = useSocket();

  useEffect(() => {
    loadBots();
  }, []);

  async function loadBots() {
    const data = await fetchApi<BotStatusResponse>('/bot-status');
    setBotData(data);
  }

  async function handleAddBot() {
    if (!newBotId.trim()) return;
    const socket = getSocket();
    socket.emit('bot:add', { botId: newBotId.trim() });
  }

  async function handleRestart(botId: string) {
    setLoading(botId);
    try {
      await postApi('/restart', { botname: botId });
      await loadBots();
    } finally {
      setLoading(null);
    }
  }

  async function handleDisconnect(botId: string) {
    setLoading(botId);
    try {
      await postApi('/disconnect', { botId });
      await loadBots();
    } finally {
      setLoading(null);
    }
  }

  const activeBots = botData?.data?.active || [];
  const inactiveBots = botData?.data?.inactive || [];
  const allBots = [...activeBots, ...inactiveBots];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Bot Management</h1>
        <Dialog open={dialogOpen} onOpenChange={(open) => { setDialogOpen(open); if (!open) setQrCode(null); }}>
          <DialogTrigger asChild>
            <Button><Plus className="h-4 w-4 mr-2" />Add Bot</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Add New Bot</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>Bot ID</Label>
                <Input
                  value={newBotId}
                  onChange={e => setNewBotId(e.target.value)}
                  placeholder="e.g. bot_03"
                />
              </div>
              <Button onClick={handleAddBot} disabled={!newBotId.trim()}>
                Generate QR
              </Button>
              {qrCode && (
                <div className="flex flex-col items-center gap-2">
                  <p className="text-sm text-gray-500">Scan this QR code with WhatsApp:</p>
                  <img src={qrCode.qr} alt="QR Code" className="w-64 h-64" />
                </div>
              )}
            </div>
          </DialogContent>
        </Dialog>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Bot ID</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {allBots.map(botId => {
            const realtimeStatus = botStatuses.get(botId);
            const isOnline = realtimeStatus
              ? realtimeStatus.status === 'open'
              : activeBots.includes(botId);

            return (
              <TableRow key={botId}>
                <TableCell className="font-medium">{botId}</TableCell>
                <TableCell>
                  <Badge variant={isOnline ? 'default' : 'destructive'}>
                    {isOnline ? 'Online' : 'Offline'}
                  </Badge>
                </TableCell>
                <TableCell className="text-right space-x-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleRestart(botId)}
                    disabled={loading === botId}
                  >
                    <RotateCcw className="h-3 w-3 mr-1" />Restart
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleDisconnect(botId)}
                    disabled={loading === botId}
                  >
                    <Power className="h-3 w-3 mr-1" />Disconnect
                  </Button>
                </TableCell>
              </TableRow>
            );
          })}
          {allBots.length === 0 && (
            <TableRow>
              <TableCell colSpan={3} className="text-center text-gray-500">No bots found</TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add -A
git commit -m "feat: implement Bot Management page with add/restart/disconnect"
```

---

### Task 8: Frontend — Send Message Page

**Files:**
- Modify: `frontend/src/pages/SendMessage.tsx`

- [ ] **Step 1: Implement Send Message page**

Replace `frontend/src/pages/SendMessage.tsx`:
```tsx
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { fetchApi, postApi, uploadFile } from '@/lib/api';
import { Send } from 'lucide-react';

interface Group {
  id: string;
  name: string;
}

interface SendResult {
  success: boolean;
  transaction_id: string;
  results: Array<{
    number: string;
    success: boolean;
    error?: string;
    response_time_seconds: number;
  }>;
}

export default function SendMessage() {
  const [groups, setGroups] = useState<Group[]>([]);
  const [selectedGroups, setSelectedGroups] = useState<string[]>([]);
  const [messageType, setMessageType] = useState<'text' | 'file' | 'url'>('text');
  const [message, setMessage] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [mediaUrl, setMediaUrl] = useState('');
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<SendResult | null>(null);
  const [groupFilter, setGroupFilter] = useState('');

  useEffect(() => {
    fetchApi<{ success: boolean; groups: Group[] }>('/groups')
      .then(data => setGroups(data.groups || []))
      .catch(() => {});
  }, []);

  function toggleGroup(groupId: string) {
    setSelectedGroups(prev =>
      prev.includes(groupId) ? prev.filter(g => g !== groupId) : [...prev, groupId]
    );
  }

  async function handleSend() {
    if (selectedGroups.length === 0) return;
    setSending(true);
    setResult(null);

    try {
      let data: SendResult;

      if (messageType === 'file' && file) {
        const formData = new FormData();
        formData.append('file', file);
        formData.append('number', selectedGroups[0]);
        formData.append('message', message);
        data = (await uploadFile('/send-media', formData)) as SendResult;
      } else if (messageType === 'url') {
        data = await postApi<SendResult>('/send-media-from-url', {
          number: selectedGroups[0],
          url: mediaUrl,
        });
      } else {
        data = await postApi<SendResult>('/send-message', {
          number: selectedGroups,
          message,
        });
      }

      setResult(data);
    } catch (err) {
      setResult({ success: false, transaction_id: '', results: [{ number: '', success: false, error: String(err), response_time_seconds: 0 }] });
    } finally {
      setSending(false);
    }
  }

  const filteredGroups = groups.filter(g =>
    g.name?.toLowerCase().includes(groupFilter.toLowerCase()) || g.id.includes(groupFilter)
  );

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Send Message</h1>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Left: form */}
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Message Type</Label>
            <Select value={messageType} onValueChange={(v) => setMessageType(v as 'text' | 'file' | 'url')}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="text">Text</SelectItem>
                <SelectItem value="file">File Upload</SelectItem>
                <SelectItem value="url">Media from URL</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {messageType === 'text' && (
            <div className="space-y-2">
              <Label>Message</Label>
              <Textarea value={message} onChange={e => setMessage(e.target.value)} rows={5} placeholder="Type your message..." />
            </div>
          )}

          {messageType === 'file' && (
            <>
              <div className="space-y-2">
                <Label>File</Label>
                <Input type="file" onChange={e => setFile(e.target.files?.[0] || null)} />
              </div>
              <div className="space-y-2">
                <Label>Caption (optional)</Label>
                <Input value={message} onChange={e => setMessage(e.target.value)} />
              </div>
            </>
          )}

          {messageType === 'url' && (
            <div className="space-y-2">
              <Label>Media URL</Label>
              <Input value={mediaUrl} onChange={e => setMediaUrl(e.target.value)} placeholder="https://..." />
            </div>
          )}

          <div className="space-y-2">
            <Label>Select Groups ({selectedGroups.length} selected)</Label>
            <Input placeholder="Filter groups..." value={groupFilter} onChange={e => setGroupFilter(e.target.value)} />
            <div className="border rounded-md max-h-60 overflow-y-auto">
              {filteredGroups.map(g => (
                <label key={g.id} className="flex items-center gap-2 px-3 py-2 hover:bg-gray-50 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={selectedGroups.includes(g.id)}
                    onChange={() => toggleGroup(g.id)}
                  />
                  <span className="text-sm truncate">{g.name || g.id}</span>
                </label>
              ))}
              {filteredGroups.length === 0 && (
                <p className="text-sm text-gray-400 p-3">No groups found</p>
              )}
            </div>
          </div>

          <Button onClick={handleSend} disabled={sending || selectedGroups.length === 0} className="w-full">
            <Send className="h-4 w-4 mr-2" />{sending ? 'Sending...' : 'Send'}
          </Button>
        </div>

        {/* Right: result */}
        {result && (
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Result — {result.transaction_id}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {result.results?.map((r, i) => (
                <div key={i} className="flex items-center justify-between text-sm">
                  <span className="truncate">{r.number}</span>
                  <Badge variant={r.success ? 'default' : 'destructive'}>
                    {r.success ? 'Sent' : r.error}
                  </Badge>
                </div>
              ))}
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add -A
git commit -m "feat: implement Send Message page with text/file/URL support"
```

---

### Task 9: Frontend — Groups Page

**Files:**
- Modify: `frontend/src/pages/Groups.tsx`

- [ ] **Step 1: Implement Groups page**

Replace `frontend/src/pages/Groups.tsx`:
```tsx
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { fetchApi, postApi } from '@/lib/api';
import { ShieldBan, ShieldCheck } from 'lucide-react';

interface Group {
  id: string;
  name: string;
  member_count: number;
  is_blocked: boolean;
}

export default function Groups() {
  const [groups, setGroups] = useState<Group[]>([]);
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  useEffect(() => {
    loadGroups();
  }, []);

  async function loadGroups() {
    setLoading(true);
    try {
      const data = await fetchApi<{ success: boolean; groups: Group[] }>('/groups');
      setGroups(data.groups || []);
    } catch {
      setGroups([]);
    } finally {
      setLoading(false);
    }
  }

  async function handleToggleBlock(group: Group) {
    setActionLoading(group.id);
    try {
      if (group.is_blocked) {
        await postApi('/groups/unblock', { groupId: group.id });
      } else {
        await postApi('/groups/block', { groupId: group.id });
      }
      await loadGroups();
    } finally {
      setActionLoading(null);
    }
  }

  const filtered = groups.filter(g =>
    (g.name || '').toLowerCase().includes(filter.toLowerCase()) ||
    g.id.includes(filter)
  );

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Groups</h1>

      <Input
        placeholder="Search groups..."
        value={filter}
        onChange={e => setFilter(e.target.value)}
        className="max-w-sm"
      />

      {loading ? (
        <p className="text-gray-500">Loading groups...</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Group ID</TableHead>
              <TableHead>Members</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map(g => (
              <TableRow key={g.id}>
                <TableCell className="font-medium">{g.name || '—'}</TableCell>
                <TableCell className="text-xs text-gray-500 font-mono">{g.id}</TableCell>
                <TableCell>{g.member_count}</TableCell>
                <TableCell>
                  <Badge variant={g.is_blocked ? 'destructive' : 'default'}>
                    {g.is_blocked ? 'Blocked' : 'Active'}
                  </Badge>
                </TableCell>
                <TableCell className="text-right">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleToggleBlock(g)}
                    disabled={actionLoading === g.id}
                  >
                    {g.is_blocked ? (
                      <><ShieldCheck className="h-3 w-3 mr-1" />Unblock</>
                    ) : (
                      <><ShieldBan className="h-3 w-3 mr-1" />Block</>
                    )}
                  </Button>
                </TableCell>
              </TableRow>
            ))}
            {filtered.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-gray-500">No groups found</TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add -A
git commit -m "feat: implement Groups page with block/unblock"
```

---

### Task 10: Frontend — Failed Requests Page

**Files:**
- Modify: `frontend/src/pages/FailedRequests.tsx`

- [ ] **Step 1: Implement Failed Requests page**

Replace `frontend/src/pages/FailedRequests.tsx`:
```tsx
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { fetchApi, postApi } from '@/lib/api';
import { RotateCcw } from 'lucide-react';

interface FailedRequest {
  transactionId: string;
  number: string | string[];
  message: string;
  saved_at: string;
}

export default function FailedRequests() {
  const [requests, setRequests] = useState<FailedRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    loadRequests();
  }, []);

  async function loadRequests() {
    setLoading(true);
    try {
      const data = await fetchApi<{ success: boolean; data: FailedRequest[] }>('/failed-requests');
      setRequests(data.data || []);
    } catch {
      setRequests([]);
    } finally {
      setLoading(false);
    }
  }

  async function handleRetryAll() {
    setRetrying(true);
    try {
      await postApi('/resend-failed', {});
      await loadRequests();
    } finally {
      setRetrying(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Failed Requests</h1>
        <div className="flex gap-2">
          <Button variant="outline" onClick={loadRequests}>Refresh</Button>
          <Button onClick={handleRetryAll} disabled={retrying || requests.length === 0}>
            <RotateCcw className="h-4 w-4 mr-2" />{retrying ? 'Retrying...' : 'Retry All'}
          </Button>
        </div>
      </div>

      {loading ? (
        <p className="text-gray-500">Loading...</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Transaction ID</TableHead>
              <TableHead>Target</TableHead>
              <TableHead>Message</TableHead>
              <TableHead>Time</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {requests.map((req, i) => (
              <TableRow key={i}>
                <TableCell className="font-mono text-xs">{req.transactionId}</TableCell>
                <TableCell className="text-xs">
                  {Array.isArray(req.number) ? req.number.join(', ') : req.number}
                </TableCell>
                <TableCell className="max-w-xs truncate text-sm">{req.message?.substring(0, 80)}</TableCell>
                <TableCell className="text-xs text-gray-500">
                  {req.saved_at ? new Date(req.saved_at).toLocaleString() : '—'}
                </TableCell>
              </TableRow>
            ))}
            {requests.length === 0 && (
              <TableRow>
                <TableCell colSpan={4} className="text-center text-gray-500">
                  No failed requests
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add -A
git commit -m "feat: implement Failed Requests page with retry all"
```

---

### Task 11: Frontend — Statistics Page

**Files:**
- Modify: `frontend/src/pages/Statistics.tsx`

- [ ] **Step 1: Implement Statistics page**

Replace `frontend/src/pages/Statistics.tsx`:
```tsx
import { useEffect, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { fetchApi } from '@/lib/api';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';

interface StatsData {
  [hour: string]: { [bot: string]: number };
}

const COLORS = ['#2563eb', '#16a34a', '#dc2626', '#ca8a04', '#9333ea', '#0891b2', '#e11d48', '#65a30d'];

export default function Statistics() {
  const [date, setDate] = useState(() => new Date().toISOString().split('T')[0]);
  const [stats, setStats] = useState<StatsData>({});
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    loadStats();
  }, [date]);

  async function loadStats() {
    setLoading(true);
    try {
      const data = await fetchApi<{ success: boolean; data: StatsData }>(`/stats/${date}`);
      setStats(data.data || {});
    } catch {
      setStats({});
    } finally {
      setLoading(false);
    }
  }

  // Transform data for recharts
  const allBots = new Set<string>();
  Object.values(stats).forEach(hour => {
    Object.keys(hour).forEach(bot => allBots.add(bot));
  });
  const botList = Array.from(allBots);

  const chartData = Array.from({ length: 24 }, (_, i) => {
    const hour = String(i).padStart(2, '0');
    const entry: Record<string, string | number> = { hour: `${hour}:00` };
    botList.forEach(bot => {
      entry[bot] = stats[hour]?.[bot] || 0;
    });
    return entry;
  });

  // Bot totals
  const botTotals: Record<string, number> = {};
  Object.values(stats).forEach(hour => {
    Object.entries(hour).forEach(([bot, count]) => {
      botTotals[bot] = (botTotals[bot] || 0) + count;
    });
  });

  const grandTotal = Object.values(botTotals).reduce((s, v) => s + v, 0);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Statistics</h1>

      <div className="flex items-end gap-4">
        <div className="space-y-2">
          <Label>Date</Label>
          <Input type="date" value={date} onChange={e => setDate(e.target.value)} className="w-48" />
        </div>
      </div>

      {loading ? (
        <p className="text-gray-500">Loading...</p>
      ) : (
        <>
          {/* Chart */}
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Messages per Hour</CardTitle>
            </CardHeader>
            <CardContent>
              {botList.length === 0 ? (
                <p className="text-gray-400 text-center py-10">No data for this date</p>
              ) : (
                <ResponsiveContainer width="100%" height={400}>
                  <BarChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="hour" fontSize={12} />
                    <YAxis fontSize={12} />
                    <Tooltip />
                    <Legend />
                    {botList.map((bot, i) => (
                      <Bar key={bot} dataKey={bot} fill={COLORS[i % COLORS.length]} stackId="a" />
                    ))}
                  </BarChart>
                </ResponsiveContainer>
              )}
            </CardContent>
          </Card>

          {/* Summary */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
            <Card>
              <CardContent className="pt-6">
                <p className="text-sm text-gray-500">Total</p>
                <p className="text-2xl font-bold">{grandTotal}</p>
              </CardContent>
            </Card>
            {Object.entries(botTotals).map(([bot, total]) => (
              <Card key={bot}>
                <CardContent className="pt-6">
                  <p className="text-sm text-gray-500 truncate">{bot}</p>
                  <p className="text-2xl font-bold">{total}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add -A
git commit -m "feat: implement Statistics page with bar charts"
```

---

### Task 12: Frontend — Logs Page

**Files:**
- Modify: `frontend/src/pages/Logs.tsx`

- [ ] **Step 1: Implement Logs page**

Replace `frontend/src/pages/Logs.tsx`:
```tsx
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { fetchApi } from '@/lib/api';
import { RefreshCw, ChevronLeft, ChevronRight } from 'lucide-react';

interface LogResponse {
  success: boolean;
  type: string;
  date: string;
  page: number;
  limit: number;
  totalLines: number;
  totalPages: number;
  lines: string[];
}

export default function Logs() {
  const [logType, setLogType] = useState('success');
  const [date, setDate] = useState(() => {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    return `${y}${m}${d}`;
  });
  const [logData, setLogData] = useState<LogResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);

  async function loadLogs(p: number = page) {
    setLoading(true);
    try {
      const data = await fetchApi<LogResponse>(`/logs/${logType}/${date}?page=${p}&limit=200`);
      setLogData(data);
      setPage(p);
    } catch {
      setLogData(null);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Logs</h1>

      <div className="flex flex-wrap items-end gap-4">
        <div className="space-y-2">
          <Label>Log Type</Label>
          <Select value={logType} onValueChange={setLogType}>
            <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="success">Success</SelectItem>
              <SelectItem value="error">Error</SelectItem>
              <SelectItem value="warn">Warning</SelectItem>
              <SelectItem value="req-res">Req/Res</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label>Date (YYYYMMDD)</Label>
          <Input value={date} onChange={e => setDate(e.target.value)} className="w-36" placeholder="20260419" />
        </div>
        <Button onClick={() => loadLogs(1)}>
          <RefreshCw className="h-4 w-4 mr-2" />Load Logs
        </Button>
      </div>

      {loading && <p className="text-gray-500">Loading...</p>}

      {logData && (
        <>
          <div className="flex items-center justify-between text-sm text-gray-500">
            <span>{logData.totalLines} total lines</span>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={page <= 1}
                onClick={() => loadLogs(page - 1)}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <span>Page {page} / {logData.totalPages}</span>
              <Button
                variant="outline"
                size="sm"
                disabled={page >= logData.totalPages}
                onClick={() => loadLogs(page + 1)}
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>

          <div className="bg-gray-900 text-green-400 rounded-lg p-4 font-mono text-xs overflow-x-auto max-h-[600px] overflow-y-auto">
            {logData.lines.map((line, i) => (
              <div key={i} className="whitespace-pre-wrap">{line}</div>
            ))}
            {logData.lines.length === 0 && (
              <div className="text-gray-500">No log entries</div>
            )}
          </div>
        </>
      )}

      {!logData && !loading && (
        <p className="text-gray-400">Select log type and date, then click Load Logs</p>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verify full frontend build**

```bash
cd frontend && npm run build
```

Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat: implement Logs page with pagination"
```

---

### Task 13: Docker — Dockerfiles, Nginx, Docker Compose

**Files:**
- Create: `backend/Dockerfile`
- Create: `backend/.dockerignore`
- Create: `frontend/Dockerfile`
- Create: `frontend/.dockerignore`
- Create: `frontend/nginx.conf`
- Create: `docker-compose.yml`

- [ ] **Step 1: Create backend Dockerfile**

Create `backend/Dockerfile`:
```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY . .
RUN mkdir -p auth_sessions data logs stats uploads
EXPOSE 8008
CMD ["node", "index.js"]
```

- [ ] **Step 2: Create backend .dockerignore**

Create `backend/.dockerignore`:
```
node_modules
auth_sessions
data
logs
stats
uploads
*.png
```

- [ ] **Step 3: Create frontend Nginx config**

Create `frontend/nginx.conf`:
```nginx
server {
    listen 80;
    server_name _;

    location /api/ {
        proxy_pass http://backend:8008/api/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
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

- [ ] **Step 4: Create frontend Dockerfile**

Create `frontend/Dockerfile`:
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
CMD ["nginx", "-g", "daemon off;"]
```

- [ ] **Step 5: Create frontend .dockerignore**

Create `frontend/.dockerignore`:
```
node_modules
dist
```

- [ ] **Step 6: Create docker-compose.yml**

Create `docker-compose.yml` at project root:
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
    restart: unless-stopped

  frontend:
    build: ./frontend
    ports:
      - "3000:80"
    depends_on:
      - backend
    restart: unless-stopped
```

- [ ] **Step 7: Verify docker-compose config**

```bash
docker compose config
```

Expected: Valid YAML output, no errors.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: add Dockerfiles, nginx config, and docker-compose.yml"
```

---

### Task 14: Update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update CLAUDE.md for new project structure**

Replace `CLAUDE.md` with updated content reflecting the new `/backend` + `/frontend` structure, Docker commands, and frontend dev workflow.

Key changes:
- Running instructions: `cd backend && npm install && node index.js` for backend, `cd frontend && npm install && npm run dev` for frontend
- Docker: `docker compose up --build`
- Architecture section: add frontend, update backend path references
- Add frontend tech stack info: React, Vite, TypeScript, Tailwind, shadcn/ui, socket.io-client, recharts

- [ ] **Step 2: Commit**

```bash
git add -A
git commit -m "docs: update CLAUDE.md for new project structure"
```
