# PM2 Running Guide

## Bahasa Indonesia

### Tujuan

Dokumen ini menjelaskan cara menjalankan project `terminal-wa-bot` dengan PM2 agar proses tetap hidup, mudah direstart, dan mudah dipantau.

### Prasyarat

- Node.js sudah terpasang
- NPM sudah terpasang
- PM2 sudah terpasang global

Instal PM2 jika belum ada:

```bash
npm install -g pm2
```

### Instalasi Project

```bash
npm install
```

### Menjalankan dengan PM2

Karena entrypoint aplikasi adalah `index.js`, jalankan:

```bash
pm2 start index.js --name terminal-wa-bot
```

### Cek Status

```bash
pm2 status
```

Atau khusus app ini:

```bash
pm2 show terminal-wa-bot
```

### Melihat Log

```bash
pm2 logs terminal-wa-bot
```

### Restart Aplikasi

```bash
pm2 restart terminal-wa-bot
```

### Stop Aplikasi

```bash
pm2 stop terminal-wa-bot
```

### Hapus dari PM2

```bash
pm2 delete terminal-wa-bot
```

### Menjalankan Saat Server Reboot

Simpan process list:

```bash
pm2 save
```

Lalu aktifkan startup:

```bash
pm2 startup
```

PM2 akan menampilkan command lanjutan yang perlu dijalankan dengan hak akses sesuai OS.

### Rekomendasi Produksi

- Gunakan nama proses tetap: `terminal-wa-bot`
- Pastikan folder berikut persisten:
  - `auth_sessions/`
  - `data/`
  - `logs/`
  - `stats/`
  - `uploads/`
- Jangan hapus folder session bila bot sudah login
- Simpan kredensial dan konfigurasi sensitif ke environment variable bila nanti kode sudah dirapikan

### Contoh Workflow Cepat

```bash
npm install
pm2 start index.js --name terminal-wa-bot
pm2 status
pm2 logs terminal-wa-bot
pm2 save
```

---

## English

### Purpose

This document explains how to run the `terminal-wa-bot` project with PM2 so the process stays alive, can be restarted easily, and is easier to monitor.

### Prerequisites

- Node.js installed
- NPM installed
- PM2 installed globally

Install PM2 if needed:

```bash
npm install -g pm2
```

### Project Installation

```bash
npm install
```

### Run with PM2

Since the application entrypoint is `index.js`, run:

```bash
pm2 start index.js --name terminal-wa-bot
```

### Check Status

```bash
pm2 status
```

Or inspect this app only:

```bash
pm2 show terminal-wa-bot
```

### View Logs

```bash
pm2 logs terminal-wa-bot
```

### Restart the App

```bash
pm2 restart terminal-wa-bot
```

### Stop the App

```bash
pm2 stop terminal-wa-bot
```

### Remove It from PM2

```bash
pm2 delete terminal-wa-bot
```

### Start on Server Reboot

Save the process list:

```bash
pm2 save
```

Then enable startup:

```bash
pm2 startup
```

PM2 will print an additional OS-specific command that must be executed with the required privileges.

### Production Recommendations

- Use a fixed process name: `terminal-wa-bot`
- Make sure these folders are persistent:
  - `auth_sessions/`
  - `data/`
  - `logs/`
  - `stats/`
  - `uploads/`
- Do not remove session folders after bots are logged in
- Move credentials and sensitive configuration to environment variables when the codebase is cleaned up

### Quick Workflow Example

```bash
npm install
pm2 start index.js --name terminal-wa-bot
pm2 status
pm2 logs terminal-wa-bot
pm2 save
```
