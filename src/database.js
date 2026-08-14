import path from 'path';
import fs from 'fs';

/**
 * PayMacchaBot — Vercel (serverless) database layer.
 *
 * Serverless functions have NO persistent filesystem, so the original SQLite
 * file cannot survive between requests. This layer replaces it with:
 *
 *   1. FULL IN-MEMORY store (zero latency reads — same as the live bot)
 *   2. Automatic sync to Cloudinary (raw file) after writes — same backup
 *      system the bot already uses, so no data is ever lost between cold
 *      starts or redeployments.
 *   3. Automatic restore from the latest Cloudinary backup on cold start.
 *
 * Data model mirrors the SQLite schema 1:1 (users, payment_methods,
 * crypto_wallets, qr_usage_history, backup_log).
 */

// ─── In-memory store ─────────────────────────────────────
const STORE = {
    users: new Map(),           // telegram_id -> { id, telegram_id, username, theme, owned_themes, created_at }
    paymentMethods: new Map(),  // "userId|name" -> { user_id, name, type, value }
    cryptoWallets: new Map(),   // "userId|name" -> { user_id, name, currency, address }
    qrUsage: [],                // [{ user_id, used_at }]
    backupLog: [],              // [{ file_name, drive_file_id, backed_up_at }]
    seq: { users: 0, payments: 0, wallets: 0, qr: 0, backups: 0 }
};

let nextId = { users: 0, misc: 0 };

function uid(kind) { return ++nextId[kind]; }

// ─── Cloudinary sync (same credentials as the bot) ───────
import { v2 as cloudinary } from 'cloudinary';

function configCloudinary() {
    cloudinary.config({
        cloud_name: process.env.CLOUDINARY_CLOUD_NAME || 'wrkyqgb9',
        api_key: process.env.CLOUDINARY_API_KEY || '336644297514517',
        api_secret: process.env.CLOUDINARY_API_SECRET || 'O-51Xu7xhEKxTZ28HcvI4VqcWko',
    });
}

/** Serialize STORE to a portable JSON blob. */
function serializeStore() {
    return JSON.stringify({
        users: Array.from(STORE.users.values()),
        paymentMethods: Array.from(STORE.paymentMethods.values()),
        cryptoWallets: Array.from(STORE.cryptoWallets.values()),
        qrUsage: STORE.qrUsage,
        backupLog: STORE.backupLog,
        nextId
    });
}

/** Hydrate STORE from a serialized blob. */
function hydrateStore(data) {
    if (!data) return false;
    STORE.users.clear(); STORE.paymentMethods.clear(); STORE.cryptoWallets.clear();
    for (const u of data.users || []) STORE.users.set(u.telegram_id, u);
    for (const p of data.paymentMethods || []) STORE.paymentMethods.set(`${p.user_id}|${p.name}`, p);
    for (const w of data.cryptoWallets || []) STORE.cryptoWallets.set(`${w.user_id}|${w.name}`, w);
    STORE.qrUsage = data.qrUsage || [];
    STORE.backupLog = data.backupLog || [];
    nextId = data.nextId || { users: 0, misc: 0 };
    return true;
}

/** Save the store to Cloudinary as a raw JSON file (debounced by caller). */
let saveTimer = null;
export function scheduleStoreSave() {
    configCloudinary();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
        try {
            const payload = Buffer.from(serializeStore()).toString('base64');
            await new Promise((resolve, reject) => {
                cloudinary.uploader.upload(
                    `data:text/plain;base64,${payload}`,
                    {
                        resource_type: 'raw',
                        public_id: 'paymacchabot/store/bot_store_latest.json',
                        overwrite: true
                    },
                    (err) => err ? reject(err) : resolve()
                );
            });
            console.log('📦 Store synced to Cloudinary');
        } catch (e) {
            console.error('⚠ Store sync failed:', e.message);
        }
    }, 1500); // debounce 1.5s
}

/** Restore the store from Cloudinary on cold start. */
export async function restoreStoreFromCloudinary() {
    try {
        configCloudinary();
        const result = await cloudinary.api.resource(
            'paymacchabot/store/bot_store_latest.json',
            { resource_type: 'raw' }
        );
        const res = await fetch(result.secure_url);
        if (!res.ok) return false;
        const data = await res.json();
        const ok = hydrateStore(data);
        if (ok) console.log(`✅ Store restored from Cloudinary (${STORE.users.size} users)`);
        return ok;
    } catch (e) {
        console.log('⚠ No Cloudinary store to restore yet (first run):', e.message);
        return false;
    }
}

// ─── DB facade (same API shape as sqlite `db` object) ─────

export async function initDB() {
    // Try restoring persisted state first; otherwise start fresh
    const restored = await restoreStoreFromCloudinary();
    if (!restored) {
        // Seed admin-owned default user is NOT needed; users register on /upi
        console.log('🧠 Starting with empty in-memory store');
    }
    return dbFacade;
}

export const dbFacade = {
    async run(sql, ...params) {
        return runSql(sql, params);
    },
    async get(sql, ...params) {
        const rows = await allSql(sql, params);
        return rows[0];
    },
    async all(sql, ...params) {
        return allSql(sql, params);
    },
    async exec() { return true; } // schema is natively created (no-op)
};

// Minimal SQL parser covering the exact statements the bot uses.
function parseAndRun(sql, params) {
    const s = sql.trim().toUpperCase();
    if (s.startsWith('INSERT OR IGNORE INTO USERS')) {
        const [tgId, username] = params;
        if (STORE.users.has(tgId)) return { changes: 0 };
        const id = uid('users');
        const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
        STORE.users.set(tgId, { id, telegram_id: tgId, username, theme: 'king', owned_themes: 'king', created_at: now });
        return { changes: 1, lastID: id };
    }
    if (s.startsWith('INSERT OR REPLACE INTO PAYMENT_METHODS')) {
        // params: tgId, value
        const [tgId, value] = params;
        const user = Array.from(STORE.users.values()).find(u => u.telegram_id === tgId);
        if (!user) return { changes: 0 };
        const key = `${user.id}|upi`;
        const exists = STORE.paymentMethods.has(key);
        STORE.paymentMethods.set(key, { user_id: user.id, name: 'upi', type: 'UPI', value });
        if (!exists) nextId.misc++;
        return { changes: 1 };
    }
    if (s.startsWith('INSERT OR REPLACE INTO CRYPTO_WALLETS')) {
        const [tgId, name, currency, address] = params;
        const user = Array.from(STORE.users.values()).find(u => u.telegram_id === tgId);
        if (!user) return { changes: 0 };
        const key = `${user.id}|${name}`;
        const exists = STORE.cryptoWallets.has(key);
        STORE.cryptoWallets.set(key, { user_id: user.id, name, currency, address });
        if (!exists) nextId.misc++;
        return { changes: 1 };
    }
    if (s.startsWith('INSERT INTO QR_USAGE_HISTORY')) {
        const [userId] = params;
        STORE.qrUsage.push({ user_id: userId, used_at: new Date().toISOString().replace('T', ' ').slice(0, 19) });
        return { changes: 1 };
    }
    if (s.startsWith('INSERT INTO BACKUP_LOG')) {
        const [fileName, driveFileId] = params;
        STORE.backupLog.push({ file_name: fileName, drive_file_id: driveFileId, backed_up_at: new Date().toISOString().replace('T', ' ').slice(0, 19) });
        return { changes: 1 };
    }
    if (s.startsWith('UPDATE USERS SET THEME')) {
        const [theme, tgId] = params;
        const user = STORE.users.get(tgId);
        if (!user) return { changes: 0 };
        user.theme = theme;
        return { changes: 1 };
    }
    if (s.startsWith('UPDATE USERS SET OWNED_THEMES')) {
        const [themes, tgId] = params;
        const user = STORE.users.get(tgId);
        if (!user) return { changes: 0 };
        user.owned_themes = themes;
        return { changes: 1 };
    }
    if (s.startsWith('DELETE FROM USERS')) {
        const [tgId] = params;
        const user = STORE.users.get(tgId);
        if (!user) return { changes: 0 };
        STORE.users.delete(tgId);
        for (const [k, v] of STORE.paymentMethods) if (v.user_id === user.id) STORE.paymentMethods.delete(k);
        for (const [k, v] of STORE.cryptoWallets) if (v.user_id === user.id) STORE.cryptoWallets.delete(k);
        return { changes: 1 };
    }
    return { changes: 0 };
}

async function runSql(sql, params) {
    const res = parseAndRun(sql, params);
    scheduleStoreSave();
    return res;
}

function allSql(sql, params) {
    const s = sql.trim().toUpperCase();
    if (s === 'SELECT TELEGRAM_ID FROM USERS') {
        return Promise.resolve(Array.from(STORE.users.values()).map(u => ({ telegram_id: u.telegram_id })));
    }
    if (s.startsWith('SELECT COUNT(*) AS COUNT FROM USERS')) {
        return Promise.resolve({ count: STORE.users.size });
    }
    if (s.startsWith('SELECT COUNT(*) AS COUNT FROM QR_USAGE_HISTORY')) {
        return Promise.resolve({ count: STORE.qrUsage.length });
    }
    if (s.startsWith('SELECT * FROM USERS')) {
        return Promise.resolve(Array.from(STORE.users.values()));
    }
    if (s.startsWith('SELECT FILE_NAME, DRIVE_FILE_ID, BACKED_UP_AT FROM BACKUP_LOG')) {
        return Promise.resolve([...STORE.backupLog].reverse().slice(0, 20));
    }
    if (s.startsWith('SELECT TELEGRAM_ID, USERNAME, THEME, CREATED_AT FROM USERS')) {
        return Promise.resolve(Array.from(STORE.users.values()).reverse().slice(0, 50));
    }
    if (s.startsWith('SELECT * FROM USERS WHERE TELEGRAM_ID =')) {
        const user = STORE.users.get(params[0]);
        return Promise.resolve(user ? [user] : []);
    }
    if (s.startsWith('SELECT ID FROM USERS WHERE TELEGRAM_ID =')) {
        const user = STORE.users.get(params[0]);
        return Promise.resolve(user ? [{ id: user.id }] : []);
    }
    if (s.startsWith('SELECT OWNED_THEMES FROM USERS WHERE TELEGRAM_ID =')) {
        const user = STORE.users.get(params[0]);
        return Promise.resolve(user ? [{ owned_themes: user.owned_themes }] : []);
    }
    if (s.startsWith('SELECT VALUE FROM PAYMENT_METHODS WHERE USER_ID =')) {
        const user = Array.from(STORE.users.values()).find(u => u.id === params[0]);
        if (!user) return Promise.resolve(undefined);
        const pm = STORE.paymentMethods.get(`${user.id}|upi`);
        return Promise.resolve(pm ? { value: pm.value } : undefined);
    }
    if (s.startsWith('SELECT NAME, CURRENCY, ADDRESS FROM CRYPTO_WALLETS WHERE USER_ID =')) {
        const user = Array.from(STORE.users.values()).find(u => u.id === params[0]);
        if (!user) return Promise.resolve([]);
        const wallets = [];
        for (const [k, w] of STORE.cryptoWallets) if (w.user_id === user.id) wallets.push(w);
        return Promise.resolve(wallets);
    }
    if (s.startsWith('SELECT COUNT(*) AS COUNT FROM QR_USAGE_HISTORY WHERE USER_ID =')) {
        const user = Array.from(STORE.users.values()).find(u => u.id === params[0]);
        const count = user ? STORE.qrUsage.filter(q => q.user_id === user.id).length : 0;
        return Promise.resolve({ count });
    }
    return Promise.resolve([]);
}
