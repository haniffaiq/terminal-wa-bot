# Technical Documentation

## Bahasa Indonesia

### Ringkasan

Project ini adalah layanan Node.js untuk mengelola bot WhatsApp berbasis `baileys`, dengan satu admin bot, beberapa operation bot, dan HTTP API untuk pengiriman pesan/media serta manajemen bot.

Dokumen ini sengaja dibuat singkat dan fokus pada cara menggunakan sistem.

### Prasyarat

- Node.js
- NPM
- Koneksi internet ke WhatsApp Web
- Folder project memiliki izin tulis untuk:
  - `auth_sessions/`
  - `data/`
  - `logs/`
  - `stats/`
  - `uploads/`

### Instalasi

```bash
npm install
```

### Menjalankan Aplikasi

Karena belum ada script start di `package.json`, jalankan langsung:

```bash
node index.js
```

Server akan berjalan di port `8008`.

### Autentikasi API

Semua endpoint HTTP memakai Basic Auth.

Credential yang saat ini tertanam di kode:

- Username: `wa-ops`
- Password: `wapass@2021`

### Cara Pakai Utama

#### 1. Menambahkan bot baru

Gunakan API:

```http
POST /addbot
```

Body:

```json
{
  "botname": "bot_ops_01"
}
```

Hasil:

- Sistem mengembalikan QR code base64
- Scan QR untuk login akun WhatsApp bot baru

#### 2. Mengirim pesan teks

```http
POST /send-message
```

Contoh body:

```json
{
  "number": ["120363xxxxxxxxx@g.us"],
  "message": "Pesan operasional"
}
```

Catatan:

- Maksimal 10 target per request
- Pengiriman ke nomor personal ditolak
- Target grup yang masuk `blocked.json` akan ditolak

#### 3. Mengirim media upload

```http
POST /send-media
```

Gunakan `multipart/form-data` dengan field:

- `number`
- `message` opsional
- `file`

#### 4. Mengirim gambar dari URL

```http
POST /send-media-from-url
```

Contoh body:

```json
{
  "number": "120363xxxxxxxxx@g.us",
  "url": "https://example.com/image.jpg"
}
```

#### 5. Melihat status bot

```http
GET /bot-status
```

#### 6. Restart bot

```http
POST /restart
```

Contoh body:

```json
{
  "botname": "bot_ops_01"
}
```

#### 7. Disconnect bot

```http
POST /disconnect
```

Contoh body:

```json
{
  "botId": "bot_ops_01"
}
```

#### 8. Melihat daftar grup dari bot aktif

```http
GET /list-my-groups
```

### Command Admin Bot

Admin bot mendukung command berikut di WhatsApp:

- `!addbot <nama_bot>`
- `!rst <nama_bot>`
- `!rmbot <nama_bot>`
- `!botstatus`
- `!restart`
- `!groupid`
- `!block <group_id>`
- `!open <group_id>`
- `!listblock`
- `!hi`
- `!ho`
- `!info`

### File Penting

- `index.js`
  Entrypoint aplikasi
- `bots/adminBot.js`
  Command admin bot
- `bots/operationBot.js`
  Lifecycle operation bot
- `utils/createSock.js`
  Factory socket WhatsApp
- `data/bot_status.json`
  Status bot
- `blocked.json`
  Daftar grup terblokir
- `failed_requests.json`
  Request gagal

### Lokasi Data Operasional

- `auth_sessions/`
  Session WhatsApp tiap bot
- `logs/`
  Log harian
- `stats/`
  Statistik pengiriman
- `uploads/`
  File sementara upload media

### Catatan Teknis Penting

- Port aplikasi di-hardcode ke `8008`
- Basic auth masih hardcoded di source code
- Belum ada test otomatis
- Persistence masih berbasis file lokal

---

## English

### Summary

This project is a Node.js service for managing WhatsApp bots through `baileys`, with one admin bot, multiple operation bots, and HTTP APIs for message/media delivery and bot management.

This document is intentionally short and focused on usage.

### Prerequisites

- Node.js
- NPM
- Internet access to WhatsApp Web
- Write access for:
  - `auth_sessions/`
  - `data/`
  - `logs/`
  - `stats/`
  - `uploads/`

### Installation

```bash
npm install
```

### Running the Application

Since there is no start script in `package.json`, run it directly:

```bash
node index.js
```

The server listens on port `8008`.

### API Authentication

All HTTP endpoints use Basic Auth.

Current credentials hardcoded in source:

- Username: `wa-ops`
- Password: `wapass@2021`

### Main Usage

#### 1. Add a new bot

Use the API:

```http
POST /addbot
```

Body:

```json
{
  "botname": "bot_ops_01"
}
```

Result:

- The system returns a base64 QR code
- Scan the QR to log in the new bot account

#### 2. Send a text message

```http
POST /send-message
```

Example body:

```json
{
  "number": ["120363xxxxxxxxx@g.us"],
  "message": "Operational message"
}
```

Notes:

- Maximum 10 targets per request
- Personal-number delivery is rejected
- Groups listed in `blocked.json` are rejected

#### 3. Send uploaded media

```http
POST /send-media
```

Use `multipart/form-data` with:

- `number`
- `message` optional
- `file`

#### 4. Send an image from URL

```http
POST /send-media-from-url
```

Example body:

```json
{
  "number": "120363xxxxxxxxx@g.us",
  "url": "https://example.com/image.jpg"
}
```

#### 5. Check bot status

```http
GET /bot-status
```

#### 6. Restart a bot

```http
POST /restart
```

Example body:

```json
{
  "botname": "bot_ops_01"
}
```

#### 7. Disconnect a bot

```http
POST /disconnect
```

Example body:

```json
{
  "botId": "bot_ops_01"
}
```

#### 8. List groups from an active bot

```http
GET /list-my-groups
```

### Admin Bot Commands

The admin bot supports these WhatsApp commands:

- `!addbot <bot_name>`
- `!rst <bot_name>`
- `!rmbot <bot_name>`
- `!botstatus`
- `!restart`
- `!groupid`
- `!block <group_id>`
- `!open <group_id>`
- `!listblock`
- `!hi`
- `!ho`
- `!info`

### Important Files

- `index.js`
  Application entrypoint
- `bots/adminBot.js`
  Admin bot commands
- `bots/operationBot.js`
  Operation bot lifecycle
- `utils/createSock.js`
  WhatsApp socket factory
- `data/bot_status.json`
  Bot status storage
- `blocked.json`
  Blocked groups
- `failed_requests.json`
  Failed requests

### Operational Data Locations

- `auth_sessions/`
  Per-bot WhatsApp sessions
- `logs/`
  Daily logs
- `stats/`
  Delivery statistics
- `uploads/`
  Temporary media upload files

### Important Technical Notes

- The application port is hardcoded to `8008`
- Basic auth is still hardcoded in source
- There are no automated tests yet
- Persistence is still local-file based
