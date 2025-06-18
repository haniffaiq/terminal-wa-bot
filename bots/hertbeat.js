const fs = require('fs');
const path = require('path');

const STATUS_FILE = path.join(__dirname, '../data/bot_status.json');

// Heartbeat yang membaca status dari file
function checkHeartbeatFromFile() {
    setInterval(() => {
        if (!fs.existsSync(STATUS_FILE)) {
            console.log('[Heartbeat] Tidak ada file status.');
            return;
        }

        try {
            const raw = fs.readFileSync(STATUS_FILE, 'utf-8');
            const statusData = JSON.parse(raw || '{}');

            const connected = [];
            const disconnected = [];

            for (const [botId, status] of Object.entries(statusData)) {
                if (status === 'open') {
                    connected.push(botId);
                } else {
                    disconnected.push(botId);
                }
            }

            console.log(`[Heartbeat] Connected: ${JSON.stringify(connected)}, Disconnected: ${JSON.stringify(disconnected)}`);
        } catch (err) {
            console.error('[Heartbeat] Gagal membaca status file:', err);
        }
    }, 5000); // Setiap 5 detik
}


module.exports = {checkHeartbeatFromFile}