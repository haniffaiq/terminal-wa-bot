# Business Documentation

## Bahasa Indonesia

### 1. Ringkasan Bisnis

Project ini adalah platform operasional internal untuk mengirim notifikasi atau pesan kerja ke grup WhatsApp melalui banyak akun bot. Sistem memisahkan fungsi pengawasan dan fungsi pengiriman: satu bot admin dipakai untuk kontrol, sedangkan beberapa bot operasi dipakai untuk menyalurkan pesan ke grup target.

Secara bisnis, solusi ini berfungsi sebagai WhatsApp delivery gateway untuk komunikasi operasional yang cepat, terukur, dan bisa dikelola oleh tim internal tanpa harus mengandalkan pengiriman manual dari perangkat manusia.

### 2. Masalah Bisnis yang Diselesaikan

Sistem ini menjawab beberapa masalah operasional yang umum:

- Pengiriman pesan ke banyak grup dilakukan manual dan lambat
- Ketergantungan pada satu akun WhatsApp menimbulkan bottleneck
- Sulit memonitor akun bot mana yang aktif atau putus
- Sulit melakukan rotasi pengiriman bila satu bot bermasalah
- Tidak ada jejak sederhana untuk statistik pengiriman dan request gagal
- Tim operasional butuh kontrol cepat tanpa harus masuk ke server

### 3. Tujuan Bisnis

Tujuan utama aplikasi ini:

- Mempercepat distribusi pesan operasional ke grup WhatsApp
- Mengurangi pekerjaan manual tim admin
- Menjaga kontinuitas pengiriman dengan banyak bot aktif
- Memudahkan onboarding, restart, dan pemantauan bot
- Menyediakan dasar data operasional untuk evaluasi performa

### 4. Nilai Utama yang Diberikan

Nilai bisnis utama dari solusi ini:

- Kecepatan
  Pesan dapat dikirim melalui API tanpa proses manual.
- Skalabilitas operasional
  Banyak bot dapat digunakan untuk menyebar beban pengiriman.
- Kontrol terpusat
  Admin dapat mengelola bot lewat satu jalur kontrol.
- Resiliensi dasar
  Bila satu bot bermasalah, sistem masih bisa memilih bot lain.
- Transparansi minimum
  Tersedia status bot, statistik, log, dan daftar request gagal.

### 5. Aktor Bisnis

Aktor utama yang tampak dari codebase:

- Admin operasional
  Mengelola bot, memeriksa status, memblokir grup, dan menangani gangguan.
- Sistem upstream atau aplikasi internal
  Mengirim request ke HTTP API untuk mendistribusikan pesan.
- Penerima grup WhatsApp
  Menerima pesan operasional di grup.
- Tim support atau engineering
  Menjaga aplikasi tetap berjalan dan memperbaiki masalah teknis.

### 6. Model Operasional Bisnis

Model operasional yang tersirat dari aplikasi:

1. Tim atau sistem internal mengirim pesan ke endpoint API.
2. Sistem memilih bot yang tersedia untuk grup target.
3. Pesan dikirim ke grup WhatsApp.
4. Jika pengiriman gagal, request dapat disimpan dan diproses ulang.
5. Admin memonitor status dan melakukan tindakan operasional bila perlu.

Selain API, admin juga bisa menjalankan command langsung via WhatsApp, sehingga kontrol lapangan tetap dapat dilakukan bahkan tanpa akses terminal.

### 7. Use Case Utama

Use case bisnis yang paling jelas:

- Mengirim notifikasi ke grup operasional
- Mengirim dokumen atau gambar ke grup
- Menambahkan bot WhatsApp baru saat kapasitas perlu ditambah
- Restart bot yang putus koneksi
- Menonaktifkan grup tertentu dari jalur distribusi
- Melihat daftar grup yang dimiliki bot
- Memeriksa status aktif atau tidak aktif seluruh bot

### 8. Kemampuan Bisnis per Fitur

#### 8.1 Pengiriman Pesan

Endpoint `POST /send-message` adalah fitur utama untuk distribusi pesan. Dari sisi bisnis, fitur ini memungkinkan integrasi sistem lain agar notifikasi operasional bisa dikirim otomatis ke grup target.

#### 8.2 Pengiriman Media

Endpoint `POST /send-media` dan `POST /send-media-from-url` memungkinkan distribusi materi non-teks seperti gambar, audio, video, atau dokumen. Ini berguna untuk laporan lapangan, lampiran bukti, atau dokumen briefing.

#### 8.3 Manajemen Bot

Endpoint `POST /addbot`, `POST /restart`, dan command admin seperti `!addbot`, `!rst`, `!restart`, `!rmbot` mendukung proses ekspansi dan pemulihan kapasitas layanan.

#### 8.4 Monitoring

Endpoint `GET /bot-status`, statistik file, heartbeat, dan command `!botstatus` mendukung pengawasan harian atas kesiapan infrastruktur bot.

#### 8.5 Kontrol Distribusi

Fitur block/unblock group memungkinkan pembatasan distribusi ke grup tertentu. Secara bisnis, ini berguna untuk mencegah pengiriman ke channel yang salah, nonaktif, atau tidak lagi valid.

### 9. Proses Operasional Harian

Proses operasional yang disarankan berdasarkan implementasi saat ini:

1. Pastikan admin bot aktif.
2. Pastikan operation bot yang diperlukan sudah login dan berstatus aktif.
3. Kirim pesan dari sistem upstream melalui API.
4. Pantau status bot secara berkala.
5. Jika ada bot gagal, lakukan restart atau reconnect.
6. Jika ada request gagal, proses melalui `resend-failed`.
7. Tinjau log dan statistik untuk evaluasi harian.

### 10. KPI yang Relevan

Meskipun aplikasi belum memiliki dashboard formal, KPI yang relevan dari solusi ini antara lain:

- Jumlah pesan berhasil terkirim per jam
- Jumlah pesan gagal per hari
- Jumlah bot aktif vs tidak aktif
- Waktu respons pengiriman per request
- Frekuensi reconnect bot
- Jumlah grup yang dilayani
- Jumlah request yang harus diresend

### 11. Asumsi Bisnis yang Terlihat

Beberapa asumsi bisnis yang tertanam pada implementasi:

- Kanal utama distribusi adalah grup WhatsApp, bukan percakapan personal
- Maksimum target per request dibatasi ke 10 penerima
- Sistem ini dipakai untuk operasi internal, bukan untuk use case publik mass-market
- Tim admin memiliki otoritas penuh atas lifecycle bot
- Keamanan saat ini diasumsikan cukup untuk lingkungan internal

### 12. Keterbatasan Bisnis Saat Ini

Keterbatasan yang perlu dipahami stakeholder:

- Sistem belum terlihat dirancang untuk skala enterprise besar
- Belum ada dashboard bisnis atau reporting formal
- Belum ada pemisahan per tenant, per unit bisnis, atau per level otorisasi
- Audit trail masih berbasis log file, bukan kontrol kepatuhan formal
- Pengiriman ke nomor personal dibatasi
- Banyak konfigurasi masih hardcoded sehingga fleksibilitas bisnis terbatas

### 13. Risiko Bisnis

Risiko utama yang tampak:

- Ketergantungan pada stabilitas koneksi WhatsApp Web dan akun bot
- Risiko keamanan karena credential API masih tertanam di source code
- Risiko operasional bila file lokal rusak atau host berpindah tanpa membawa session
- Risiko gangguan layanan bila reconnect logic gagal
- Risiko governance karena kontrol akses masih sangat sederhana
- Risiko human error pada pengelolaan block list dan lifecycle bot

### 14. Kapan Solusi Ini Cocok Digunakan

Solusi ini paling cocok untuk:

- Tim operasional internal
- Notifikasi kerja berbasis grup
- Lingkungan dengan kebutuhan implementasi cepat
- Organisasi yang belum membutuhkan platform messaging enterprise penuh
- Use case yang memprioritaskan pragmatisme dan kecepatan delivery

### 15. Kapan Solusi Ini Perlu Ditingkatkan

Solusi ini perlu ditingkatkan bila organisasi membutuhkan:

- kontrol keamanan yang lebih kuat
- audit dan compliance formal
- multi-tenant architecture
- volume pengiriman lebih tinggi
- integrasi observability dan reporting yang matang
- high availability lintas instance atau lintas server

### 16. Rekomendasi Bisnis

Rekomendasi bisnis jangka dekat:

- Tetapkan ownership yang jelas antara admin operasional dan engineering
- Definisikan SOP onboarding bot, restart bot, dan penanganan request gagal
- Dokumentasikan daftar grup valid dan block list governance
- Gunakan KPI minimum untuk evaluasi performa layanan

Rekomendasi jangka menengah:

- Bentuk dashboard monitoring untuk status bot dan keberhasilan pengiriman
- Pisahkan environment konfigurasi dari source code
- Tambahkan role-based access untuk operasi administratif

Rekomendasi jangka panjang:

- Pertimbangkan migrasi ke arsitektur yang lebih scalable dan aman
- Tambahkan lapisan persistence yang lebih kuat
- Bangun model pelaporan layanan yang lebih formal untuk stakeholder

### 17. Ringkasan Eksekutif

Secara bisnis, aplikasi ini adalah mesin distribusi pesan WhatsApp internal yang membantu organisasi:

- mengirim informasi lebih cepat
- mengurangi kerja manual
- menjaga kontinuitas operasional dengan banyak bot
- mempertahankan kontrol terpusat atas pengiriman

Nilai utamanya kuat untuk operasi internal yang pragmatis. Namun, agar siap untuk skala dan governance yang lebih tinggi, aplikasi ini masih memerlukan penguatan pada keamanan, auditability, dan pengelolaan konfigurasi.

---

## English

### 1. Business Summary

This project is an internal operational platform used to send notifications or work messages to WhatsApp groups through multiple bot accounts. The system separates supervision and delivery responsibilities: one admin bot is used for control, while multiple operation bots are used for message distribution to target groups.

From a business perspective, this solution acts as a WhatsApp delivery gateway for fast, manageable, and repeatable operational communication without relying on manual sending from human-operated devices.

### 2. Business Problems It Solves

The system addresses several common operational problems:

- Sending messages to many groups manually is slow
- Relying on a single WhatsApp account creates a bottleneck
- It is hard to monitor which bot accounts are connected or disconnected
- It is difficult to rotate sending capacity when one bot has an issue
- There is no simple trace for message statistics and failed requests
- The operations team needs quick control without direct server access

### 3. Business Objectives

The main business objectives are:

- accelerate operational message distribution to WhatsApp groups
- reduce manual workload for administrators
- maintain sending continuity with multiple active bots
- simplify bot onboarding, restart, and monitoring
- provide baseline operational data for performance evaluation

### 4. Core Value Proposition

The main business value of this solution:

- Speed
  Messages can be sent through APIs without manual steps.
- Operational scalability
  Multiple bots can be used to spread delivery load.
- Centralized control
  Admins can manage bots through one control path.
- Basic resilience
  If one bot fails, the system may still route through another bot.
- Minimum transparency
  Bot status, statistics, logs, and failed requests are available.

### 5. Business Actors

The main actors visible from the codebase:

- Operations admin
  Manages bots, checks status, blocks groups, and handles incidents.
- Upstream systems or internal applications
  Call the HTTP APIs to distribute messages.
- WhatsApp group recipients
  Receive operational messages in groups.
- Support or engineering team
  Keeps the application running and fixes technical issues.

### 6. Business Operating Model

The operating model implied by the application:

1. An internal team or system sends a message through the API.
2. The system selects an available bot for the target group.
3. The message is delivered to the WhatsApp group.
4. If delivery fails, the request can be stored and retried later.
5. Admins monitor status and take operational action when needed.

In addition to APIs, admins can also run commands directly through WhatsApp, allowing field control even without terminal access.

### 7. Main Use Cases

The clearest business use cases:

- sending notifications to operational groups
- sending documents or images to groups
- adding a new WhatsApp bot when capacity needs to grow
- restarting a disconnected bot
- disabling a specific group from the delivery route
- viewing the group list owned by a bot
- checking active and inactive bot status

### 8. Business Capabilities by Feature

#### 8.1 Message Delivery

The `POST /send-message` endpoint is the main distribution feature. From a business standpoint, it allows other systems to integrate and send operational notifications automatically to target groups.

#### 8.2 Media Delivery

The `POST /send-media` and `POST /send-media-from-url` endpoints support non-text distribution such as images, audio, video, or documents. This is useful for field reports, evidence attachments, or briefing materials.

#### 8.3 Bot Management

The `POST /addbot`, `POST /restart`, and admin commands such as `!addbot`, `!rst`, `!restart`, and `!rmbot` support capacity expansion and service recovery.

#### 8.4 Monitoring

The `GET /bot-status` endpoint, stats files, heartbeat logs, and the `!botstatus` command support daily supervision of bot infrastructure readiness.

#### 8.5 Distribution Control

The block/unblock group feature allows delivery restrictions for specific groups. From a business standpoint, this is useful to prevent sending to the wrong, inactive, or no-longer-valid channels.

### 9. Daily Operational Process

A practical daily operating flow based on the current implementation:

1. Ensure the admin bot is active.
2. Ensure the required operation bots are logged in and active.
3. Send messages from upstream systems through the API.
4. Monitor bot status periodically.
5. If a bot fails, restart or reconnect it.
6. If failed requests exist, process them through `resend-failed`.
7. Review logs and statistics for daily evaluation.

### 10. Relevant KPIs

Even though there is no formal dashboard yet, relevant KPIs include:

- number of successfully delivered messages per hour
- number of failed messages per day
- number of active vs inactive bots
- delivery response time per request
- bot reconnect frequency
- number of groups served
- number of requests that require resend

### 11. Visible Business Assumptions

Several business assumptions are embedded in the implementation:

- the main delivery channel is WhatsApp groups, not personal chats
- the maximum target count per request is 10 recipients
- this system is intended for internal operations, not public mass-market use cases
- the admin team has full authority over bot lifecycle management
- current security is assumed to be sufficient for an internal environment

### 12. Current Business Limitations

Stakeholders should understand these limitations:

- the system does not appear designed for large enterprise scale
- there is no formal business dashboard or reporting layer
- there is no tenant, business-unit, or advanced authorization separation
- audit trails are still file-log based, not formal compliance controls
- personal-number delivery is restricted
- many configurations are still hardcoded, limiting business flexibility

### 13. Business Risks

Key visible risks:

- dependence on WhatsApp Web stability and bot account availability
- security risk because API credentials are hardcoded in source
- operational risk if local files are damaged or the host changes without session migration
- service disruption risk if reconnect logic fails
- governance risk because access control is still very simple
- human-error risk in block-list and bot lifecycle management

### 14. When This Solution Fits

This solution is best suited for:

- internal operations teams
- group-based operational notifications
- environments that need fast implementation
- organizations that do not yet need a full enterprise messaging platform
- use cases that prioritize pragmatic delivery speed

### 15. When This Solution Needs Upgrading

The solution should be upgraded when the organization needs:

- stronger security controls
- formal audit and compliance support
- multi-tenant architecture
- higher delivery volume
- mature observability and reporting integration
- high availability across instances or servers

### 16. Business Recommendations

Short-term recommendations:

- define clear ownership between operations admin and engineering
- define SOPs for bot onboarding, bot restart, and failed-request handling
- document valid group lists and block-list governance
- use baseline KPIs to evaluate service performance

Medium-term recommendations:

- build a monitoring dashboard for bot status and delivery success
- move configuration out of source code
- add role-based access for administrative actions

Long-term recommendations:

- consider migrating to a more scalable and secure architecture
- add a stronger persistence layer
- build a more formal service reporting model for stakeholders

### 17. Executive Summary

From a business perspective, this application is an internal WhatsApp message distribution engine that helps an organization:

- send information faster
- reduce manual effort
- maintain operational continuity through multiple bots
- keep centralized control over message delivery

Its value is strong for pragmatic internal operations. However, to be ready for higher scale and stronger governance, the application still needs improvements in security, auditability, and configuration management.
