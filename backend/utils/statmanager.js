const fs = require("fs");
const path = require("path");

const STATS_DIR = path.join(__dirname, "../stats");

let currentHourStats = {};
let currentHour = null;
let currentDate = null;

// Ensure stats folder exists
function ensureStatsDir() {
    if (!fs.existsSync(STATS_DIR)) {
        fs.mkdirSync(STATS_DIR, { recursive: true });
    }
}

// Get formatted date parts
function getDateParts() {
    const now = new Date();
    return {
        yyyy: now.getFullYear(),
        mm: String(now.getMonth() + 1).padStart(2, "0"),
        dd: String(now.getDate()).padStart(2, "0"),
        hour: String(now.getHours()).padStart(2, "0")
    };
}

// Get today file path
function getTodayFile() {
    const { yyyy, mm, dd } = getDateParts();
    return path.join(STATS_DIR, "stats-" + yyyy + "-" + mm + "-" + dd + ".json");
}

// Create file if not exists
function ensureTodayFile() {
    const filePath = getTodayFile();

    if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, JSON.stringify({}, null, 2));
    }

    return filePath;
}

// Increment counter
function increment(botName) {
    const { yyyy, mm, dd, hour } = getDateParts();
    const today = yyyy + "-" + mm + "-" + dd;

    // Kalau tanggal berubah → reset semuanya
    if (currentDate !== today) {
        currentHourStats = {};
        currentHour = hour;
        currentDate = today;
    }

    // Kalau jam berubah → reset counter jam baru
    if (currentHour !== hour) {
        currentHourStats = {};
        currentHour = hour;
    }

    if (!currentHourStats[botName]) {
        currentHourStats[botName] = 0;
    }

    currentHourStats[botName]++;
}

// Flush ke file
function flush() {
    if (!currentHour || !currentDate) return;

    ensureStatsDir();
    const filePath = ensureTodayFile();

    let data = {};

    try {
        const raw = fs.readFileSync(filePath);
        data = JSON.parse(raw);
    } catch (err) {
        console.error("Stats file corrupted, recreating...");
        data = {};
    }

    if (!data[currentHour]) {
        data[currentHour] = {};
    }

    for (const bot in currentHourStats) {
        if (!data[currentHour][bot]) {
            data[currentHour][bot] = 0;
        }
        data[currentHour][bot] += currentHourStats[bot];
    }

    const tempPath = filePath + ".tmp";
    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
    fs.renameSync(tempPath, filePath);

    // Reset counter setelah flush
    currentHourStats = {};
}

module.exports = {
    increment,
    flush
};