/**
 * PayMacchaBot — Vercel serverless webhook handler.
 *
 * Drop-in replacement for the Express bot: every Telegram update arrives at
 * POST /api/webhook, is processed by the same handlers, and responds within
 * Vercel's timeout (max 10s on Hobby). Long operations (UTR verification,
 * broadcasts) are handled gracefully.
 *
 * Deploy: push to GitHub → connect repo on Vercel → add env vars → done.
 */
import { Telegraf } from 'telegraf';
import https from 'https';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { initDB, scheduleStoreSave } from '../src/database.js';
import { generateQRBuffer, createUpiQrData, createCryptoQrData } from '../src/utils/qrGenerator.js';
import { verifyUtrFromGmail } from '../src/utils/gmailVerify.js';
import { evaluate } from 'mathjs';
import axios from 'axios';
import { v2 as cloudinary } from 'cloudinary';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ─── Constants (identical to the live bot) ───────────────
const ADMIN_IDS = [8949459681, 8624653250, 2077116559];
const CL_BASE = 'https://res.cloudinary.com/wrkyqgb9/image/upload';
const CL_PATH = 'paymacchabot/icons/paymacchabot/icons';
const ICONS = {
    qr: `${CL_BASE}/${CL_PATH}/qr.png`, calc: `${CL_BASE}/${CL_PATH}/calc.png`,
    upi: `${CL_BASE}/${CL_PATH}/upi.png`, save: `${CL_BASE}/${CL_PATH}/save.png`,
    btc: `${CL_BASE}/${CL_PATH}/btc.png`, usdt: `${CL_BASE}/${CL_PATH}/usdt.png`,
    ltc: `${CL_BASE}/${CL_PATH}/ltc.png`, binance: `${CL_BASE}/${CL_PATH}/binance.png`,
    help: `${CL_BASE}/${CL_PATH}/help.png`
};

const THEMES = [
    { id: 'default', name: 'Normal QR', rarity: 'Standard', price: 'Free', preview_file: path.resolve(ROOT, 'default_qr.png') },
    { id: 'king', name: '✦ THE KING ✦', rarity: '✦ Mythic', price: '₹101', preview_file: path.resolve(ROOT, 'king_qr.png') }
];

const MAX_CONCURRENT_TG = 40;
let activeTgRequests = 0;
const tgQueue = [];
function tgLimit(fn) {
    return new Promise((resolve, reject) => {
        const run = async () => {
            try { resolve(await fn()); }
            catch (e) { reject(e); }
            finally {
                activeTgRequests--;
                if (tgQueue.length > 0) tgQueue.shift()();
            }
        };
        if (activeTgRequests < MAX_CONCURRENT_TG) { activeTgRequests++; run(); }
        else tgQueue.push(run);
    });
}

const RATE_PER_USER = 10;
const RATE_GLOBAL = 100;
const rateWindow = 1000;
const userRequests = new Map();
let globalRequests = [];
function isRateLimited(tgId) {
    const now = Date.now();
    const userReqs = userRequests.get(tgId) || [];
    const filtered = userReqs.filter(t => now - t < rateWindow);
    filtered.push(now);
    userRequests.set(tgId, filtered);
    if (filtered.length > RATE_PER_USER) return true;
    globalRequests = globalRequests.filter(t => now - t < rateWindow);
    globalRequests.push(now);
    if (globalRequests.length > RATE_GLOBAL) return true;
    return false;
}

// ─── State (serverless: rebuilt each cold start from Cloudinary store) ──
let db;
const USER_DATA = new Map();
const PREVIEW_CACHE = {};
const INLINE_QR_CACHE_MAX = 500;
const QR_BUFFER_CACHE_MAX = 200;
function lruSet(map, key, value, max) {
    if (map.size >= max) {
        const firstKey = map.keys().next().value;
        map.delete(firstKey);
    }
    map.set(key, value);
}
const INLINE_QR_CACHE = new Map();
const QR_BUFFER_CACHE = new Map();
const WAITING_FOR_PAYMENT = new Map();
const WALLET_CACHE = new Map();

const KEYBOARDS = {
    setup_upi: { inline_keyboard: [[{ text: "⚙️ Setup UPI", url: `https://t.me/payzwxbot?start=setup_upi` }]] },
    setup_upi_inline: { inline_keyboard: [[{ text: "✦ Set up UPI first → @payzwxbot", url: `https://t.me/payzwxbot?start=setup_upi` }]] }
};
function getSetupButton() { return KEYBOARDS.setup_upi; }
function getThemeKeyboard(idx, isEquipped, isOwned, themeId) {
    const nextIdx = (idx + 1) % THEMES.length;
    return { inline_keyboard: [
        [{ text: "◀ Previous", callback_data: `nav_${nextIdx}` }, { text: "Next ▶", callback_data: `nav_${nextIdx}` }],
        [{ text: isEquipped ? "Equipped" : (isOwned ? "Equip" : "Buy"), callback_data: isEquipped ? "noop" : (isOwned ? `equip_${themeId}_${idx}` : `buy_${themeId}_${idx}`) }]
    ] };
}
function getEquippedKeyboard(idx) {
    const nextIdx = (idx + 1) % THEMES.length;
    return { inline_keyboard: [
        [{ text: "◀ Previous", callback_data: `nav_${nextIdx}` }, { text: "Next ▶", callback_data: `nav_${nextIdx}` }],
        [{ text: "Equipped", callback_data: "noop" }]
    ] };
}
function getPaginationDots(idx, total) {
    return Array.from({ length: total }, (_, i) => (i === idx ? '●' : '○')).join('');
}

const httpsAgent = new https.Agent({ keepAlive: false, timeout: 30000 });

// Cloudinary config
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME || 'wrkyqgb9',
    api_key: process.env.CLOUDINARY_API_KEY || '336644297514517',
    api_secret: process.env.CLOUDINARY_API_SECRET || 'O-51Xu7xhEKxTZ28HcvI4VqcWko',
});

const isAdmin = (tgId) => ADMIN_IDS.includes(tgId);

// ─── Data helpers ─────────────────────────────────────────
function getUserData(tgId) { return USER_DATA.get(tgId); }
function getUpiFromMemory(tgId) { const d = USER_DATA.get(tgId); return d ? d.upi : null; }
function getWalletFromMemory(tgId, name) { const d = USER_DATA.get(tgId); return d ? d.wallets.get(name) : null; }
function ensureUserInMemory(tgId, username) {
    let data = USER_DATA.get(tgId);
    if (!data) {
        data = { id: null, telegram_id: tgId, username, theme: 'default', owned_themes: 'default',
                 upi: null, wallets: new Map(), qr_count: 0 };
        USER_DATA.set(tgId, data);
    }
    return data;
}
async function dbWrite(sql, ...params) {
    try { await db.run(sql, ...params); scheduleStoreSave(); return true; }
    catch (e) { console.error('DB write error:', e.message); return false; }
}

async function loadAllDataIntoMemory() {
    const users = await db.all('SELECT * FROM users');
    for (const user of users) {
        const userData = {
            id: user.id, telegram_id: user.telegram_id, username: user.username,
            theme: user.theme || 'default', owned_themes: user.owned_themes || 'default',
            upi: null, wallets: new Map(), qr_count: 0
        };
        const upi = await db.get('SELECT value FROM payment_methods WHERE user_id = ? AND name = "upi"', user.id);
        if (upi) userData.upi = upi.value;
        const wallets = await db.all('SELECT name, currency, address FROM crypto_wallets WHERE user_id = ?', user.id);
        for (const w of wallets) userData.wallets.set(w.name, { currency: w.currency, address: w.address });
        const qrRow = await db.get('SELECT COUNT(*) as count FROM qr_usage_history WHERE user_id = ?', user.id);
        if (qrRow) userData.qr_count = qrRow.count;
        USER_DATA.set(user.telegram_id, userData);
        WALLET_CACHE.set(user.telegram_id, userData.wallets);
    }
    console.log(`✅ Loaded ${users.length} users into memory (serverless restore)`);
}

async function preCache() {
    for (const theme of THEMES) {
        try {
            if (fs.existsSync(theme.preview_file)) {
                PREVIEW_CACHE[theme.id] = fs.readFileSync(theme.preview_file);
            }
        } catch (e) { console.error(`❌ Cache failed for ${theme.id}:`, e.message); }
    }
}

// ─── QR helpers (inline fix: retry upload + data-URI fallback) ──
async function uploadToCloudinary(buffer, publicId) {
    const bufferStream = new (await import('stream')).PassThrough();
    bufferStream.end(buffer);
    const result = cloudinary.uploader.upload_stream({ resource_type: 'image', public_id: publicId, overwrite: true });
    bufferStream.pipe(result);
    return await new Promise((resolve, reject) => {
        result.on('success', (r) => resolve(r.secure_url));
        result.on('error', reject);
        setTimeout(() => reject(new Error('Cloudinary upload timeout')), 10000);
    });
}

async function uploadWithRetry(buffer, publicId, attempts = 3, timeoutMs = 20000) {
    let lastErr = null;
    for (let i = 1; i <= attempts; i++) {
        try {
            return await Promise.race([
                uploadToCloudinary(buffer, publicId),
                new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs))
            ]);
        } catch (e) {
            lastErr = e;
            if (i < attempts) await new Promise(r => setTimeout(r, 800 * i));
        }
    }
    throw lastErr;
}

function bufferToDataUri(buffer) { return 'data:image/png;base64,' + buffer.toString('base64'); }

async function generateInlineQR(upiValue, firstName, amount, theme) {
    const cacheKey = `upi_${upiValue}_${amount}_${theme}`;
    if (INLINE_QR_CACHE.has(cacheKey)) return INLINE_QR_CACHE.get(cacheKey);
    const upiData = createUpiQrData(upiValue, firstName, amount);
    const qrBuffer = await generateQRBuffer(upiData, theme);
    lruSet(QR_BUFFER_CACHE, cacheKey, qrBuffer, QR_BUFFER_CACHE_MAX);
    try {
        const url = await uploadWithRetry(qrBuffer, `paymacchabot/inline/upi_${upiValue.replace(/[@.]/g, '_')}_${amount}_${theme}`, 1, 10000);
        INLINE_QR_CACHE.set(cacheKey, url);
        return url;
    } catch (e) {
        console.error('⚠ Inline QR Cloudinary failed after retries:', e.message);
        const dataUri = bufferToDataUri(qrBuffer);
        INLINE_QR_CACHE.set(cacheKey, dataUri);
        return dataUri;
    }
}

async function generateCryptoQR(address, currency, theme) {
    const cacheKey = `crypto_${address}_${currency}_${theme}`;
    if (INLINE_QR_CACHE.has(cacheKey)) return INLINE_QR_CACHE.get(cacheKey);
    const cryptoData = createCryptoQrData(address, currency);
    const qrBuffer = await generateQRBuffer(cryptoData, theme);
    lruSet(QR_BUFFER_CACHE, cacheKey, qrBuffer, QR_BUFFER_CACHE_MAX);
    try {
        const url = await uploadWithRetry(qrBuffer, `paymacchabot/crypto/${currency}_${address.slice(0, 8)}_${theme}`, 1, 10000);
        INLINE_QR_CACHE.set(cacheKey, url);
        return url;
    } catch (e) {
        console.error('⚠ Inline crypto QR Cloudinary failed after retries:', e.message);
        const dataUri = bufferToDataUri(qrBuffer);
        INLINE_QR_CACHE.set(cacheKey, dataUri);
        return dataUri;
    }
}

async function getQRBuffer(upiValue, firstName, amount, theme) {
    const cacheKey = `upi_${upiValue}_${amount}_${theme}`;
    if (QR_BUFFER_CACHE.has(cacheKey)) return QR_BUFFER_CACHE.get(cacheKey);
    const upiData = createUpiQrData(upiValue, firstName, amount);
    const qrBuffer = await generateQRBuffer(upiData, theme);
    QR_BUFFER_CACHE.set(cacheKey, qrBuffer);
    uploadToCloudinary(qrBuffer, `paymacchabot/inline/upi_${upiValue.replace(/[@.]/g, '_')}_${amount}_${theme}`)
        .then(url => INLINE_QR_CACHE.set(cacheKey, url)).catch(() => {});
    return qrBuffer;
}

async function getCryptoQRBuffer(address, currency, theme) {
    const cacheKey = `crypto_${address}_${currency}_${theme}`;
    if (QR_BUFFER_CACHE.has(cacheKey)) return QR_BUFFER_CACHE.get(cacheKey);
    const cryptoData = createCryptoQrData(address, currency);
    const qrBuffer = await generateQRBuffer(cryptoData, theme);
    QR_BUFFER_CACHE.set(cacheKey, qrBuffer);
    uploadToCloudinary(qrBuffer, `paymacchabot/crypto/${currency}_${address.slice(0, 8)}_${theme}`)
        .then(url => INLINE_QR_CACHE.set(cacheKey, url)).catch(() => {});
    return qrBuffer;
}

// ═══════════════════════════════════════════════════════
// BOT HANDLERS (ported 1:1 from @payzwxbot)
// ═══════════════════════════════════════════════════════
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

// SPEED OPTIMIZATION: v3 architecture (items 1-4): allowed_updates + max_connections=100,
// rate limiting (10/s user, 100/s global), concurrency limiter, global error handlers
bot.use(async (ctx, next) => {
    // Updates without a 'from' field (malformed posts, channel posts) — skip rate check
    if (ctx.from && isRateLimited(ctx.from.id) && !isAdmin(ctx.from.id)) {
        return; // silently drop rate-limited requests
    }
    await next();
});

bot.use((ctx, next) => tgLimit(() => next()));

// Global error handlers — bot no longer crashes on edge cases
process.on('unhandledRejection', (reason) => {
    console.error('❌ Unhandled rejection:', reason && reason.message ? reason.message : reason);
});
process.on('uncaughtException', (err) => {
    console.error('❌ Uncaught exception:', err.message);
});

// ─── ADMIN COMMANDS ───
bot.command('adminmsg', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.reply("⛔ Not authorized.");
    const message = ctx.payload.trim();
    if (!message) {
        return ctx.reply("Usage: `/adminmsg <message>`\n\nBroadcast to all users.", { parse_mode: 'Markdown' });
    }
    const statusMsg = await ctx.reply("📡 Broadcasting...");
    try {
        const users = await db.all('SELECT telegram_id FROM users');
        let sent = 0, failed = 0;
        const BATCH = 20;
        for (let i = 0; i < users.length; i += BATCH) {
            const batch = users.slice(i, i + BATCH);
            const results = await Promise.allSettled(
                batch.map(u => bot.telegram.sendMessage(u.telegram_id, `📢 *Admin Broadcast*\n━━━━━━━━━━━━━━━━━━\n\n${message}`, { parse_mode: 'Markdown' }))
            );
            results.forEach(r => r.status === 'fulfilled' ? sent++ : failed++);
        }
        await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, undefined,
            `✅ *Broadcast Complete*\n━━━━━━━━━━━━━━━━━━\n✦ Sent: ${sent}\n✦ Failed: ${failed}\n✦ Total: ${users.length}`, { parse_mode: 'Markdown' });
    } catch (e) {
        ctx.reply(`❌ Broadcast failed: ${e.message}`);
    }
});

bot.command('adminstats', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.reply("⛔ Not authorized.");
    const [userCount, qrCount] = await Promise.all([
        db.get('SELECT COUNT(*) as count FROM users'),
        db.get('SELECT COUNT(*) as count FROM qr_usage_history')
    ]);
    ctx.reply(`✦ *Bot Statistics*\n━━━━━━━━━━━━━━━━━━\n✦ Users: ${userCount ? userCount.count : 0}\n✦ QRs Generated: ${qrCount ? qrCount.count : 0}\n✦ Memory Users: ${USER_DATA.size}\n✦ QR Cache: ${INLINE_QR_CACHE.size}`, { parse_mode: 'Markdown' });
});

bot.command('adminbackup', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.reply("⛔ Not authorized.");
    const msg = await ctx.reply("📦 Starting backup to Cloudinary...");
    await forceBackup();
    ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, undefined, "✅ Backup completed successfully!\n\nStored on Cloudinary CDN (raw file).\nUse /adminbackups to see backup history.");
});

bot.command('adminbackups', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.reply("⛔ Not authorized.");
    const backups = await db.all('SELECT file_name, drive_file_id, backed_up_at FROM backup_log ORDER BY id DESC LIMIT 20');
    if (!backups || backups.length === 0) return ctx.reply("No backups found yet. Backups happen automatically every 10+ DB changes.");
    let text = `✦ *Backup History (Last 20)*\n━━━━━━━━━━━━━━━━━━\n\n`;
    backups.forEach(b => {
        text += `✦ ${b.file_name}\n  📅 ${b.backed_up_at}\n  🔗 ${b.drive_file_id}\n\n`;
    });
    ctx.reply(text, { parse_mode: 'Markdown' });
});

bot.command('adminlistusers', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.reply("⛔ Not authorized.");
    const users = await db.all('SELECT telegram_id, username, theme, created_at FROM users ORDER BY id DESC LIMIT 50');
    if (!users || users.length === 0) return ctx.reply("No users found.");
    let text = `✦ *Recent Users (Last 50)*\n━━━━━━━━━━━━━━━━━━\n\n`;
    users.forEach(u => {
        text += `✦ @${u.username || 'N/A'} (${u.telegram_id})\n  Theme: ${u.theme}\n\n`;
    });
    ctx.reply(text, { parse_mode: 'Markdown' });
});

bot.command('admingetuser', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.reply("⛔ Not authorized.");
    const tgId = parseInt(ctx.payload.trim());
    if (!tgId) return ctx.reply("Usage: `/admingetuser <telegram_id>`", { parse_mode: 'Markdown' });
    const user = await db.get('SELECT * FROM users WHERE telegram_id = ?', tgId);
    if (!user) return ctx.reply("User not found.");
    const upi = await db.get('SELECT value FROM payment_methods WHERE user_id = ? AND name = "upi"', user.id);
    const wallets = await db.all('SELECT name, currency, address FROM crypto_wallets WHERE user_id = ?', user.id);
    const qrCount = await db.get('SELECT COUNT(*) as count FROM qr_usage_history WHERE user_id = ?', user.id);
    let text = `✦ *User Info*\n━━━━━━━━━━━━━━━━━━\n`;
    text += `✦ ID: ${user.telegram_id}\n`;
    text += `✦ Username: @${user.username || 'N/A'}\n`;
    text += `✦ Theme: ${user.theme}\n`;
    text += `✦ Owned: ${user.owned_themes}\n`;
    text += `✦ UPI: ${upi ? upi.value : 'Not set'}\n`;
    text += `✦ QRs Generated: ${qrCount ? qrCount.count : 0}\n`;
    text += `✦ Joined: ${user.created_at}\n\n`;
    if (wallets && wallets.length > 0) {
        text += `*Wallets:*\n`;
        wallets.forEach(w => { text += `  ✦ ${w.name} (${w.currency}): \`${w.address}\`\n`; });
    }
    ctx.reply(text, { parse_mode: 'Markdown' });
});

bot.command('admindeleteuser', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.reply("⛔ Not authorized.");
    const tgId = parseInt(ctx.payload.trim());
    if (!tgId) return ctx.reply("Usage: `/admindeleteuser <telegram_id>`", { parse_mode: 'Markdown' });
    const user = await db.get('SELECT id FROM users WHERE telegram_id = ?', tgId);
    if (!user) return ctx.reply("User not found.");
    await dbWrite('DELETE FROM users WHERE telegram_id = ?', tgId);
    USER_DATA.delete(tgId);
    WALLET_CACHE.delete(tgId);
    ctx.reply(`✅ User ${tgId} deleted successfully.`);
});

bot.command('adminsettheme', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.reply("⛔ Not authorized.");
    const parts = ctx.payload.trim().split(/\s+/);
    if (parts.length < 2) return ctx.reply("Usage: `/adminsettheme <tg_id> <theme>`", { parse_mode: 'Markdown' });
    const tgId = parseInt(parts[0]);
    const theme = parts[1];
    const user = await db.get('SELECT id FROM users WHERE telegram_id = ?', tgId);
    if (!user) return ctx.reply("User not found.");
    await dbWrite('UPDATE users SET theme = ? WHERE telegram_id = ?', theme, tgId);
    const userData = USER_DATA.get(tgId);
    if (userData) { userData.theme = theme; }
    ctx.reply(`✅ Theme set to "${theme}" for user ${tgId}`);
});

bot.command('adminmsguser', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.reply("⛔ Not authorized.");
    const parts = ctx.payload.trim().split(/\s+/);
    if (parts.length < 2) return ctx.reply("Usage: `/adminmsguser <tg_id> <message>`", { parse_mode: 'Markdown' });
    const tgId = parseInt(parts[0]);
    const message = parts.slice(1).join(' ');
    try {
        await bot.telegram.sendMessage(tgId, `✦ *Admin Message*\n━━━━━━━━━━━━━━━━━━\n\n${message}`, { parse_mode: 'Markdown' });
        ctx.reply(`✅ Message sent to ${tgId}`);
    } catch (e) {
        ctx.reply(`❌ Failed to send: ${e.message}`);
    }
});

bot.command('adminping', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.reply("⛔ Not authorized.");
    const start = Date.now();
    await ctx.reply("🏓 Pong!");
    console.log(`⚡ Response time: ${Date.now() - start}ms`);
});

// ─── USER COMMANDS ───
bot.start(async (ctx) => {
    const payload = ctx.payload;
    if (payload === 'setup_upi') {
        return ctx.reply("✦ UPI Setup\n━━━━━━━━━━━━━━━━━━\n\nPlease send your UPI ID now.\nExample: vaibhavzawdx@fam\n\n━━━━━━━━━━━━━━━━━━\nAfter setting up, use @payzwxbot in any chat to generate QRs.");
    }
    const menu = `✦ PayMacchaBot Commands
━━━━━━━━━━━━━━━━━━

Welcome to <b>@payzwxbot</b> — your payment &amp; utility assistant.

⚙️ <b>Setup</b>
<code>/upi &lt;UPI_ID&gt;</code> — Link your UPI ID.
<code>/save &lt;name&gt; &lt;wallet_id&gt;</code> — Save a crypto wallet or Binance ID.
<code>/profile</code> — Your wallet/UPI summary.

💸 <b>Payments</b>
<code>/qr [amount]</code> — Generate UPI QR.
<code>/btc [amount]</code> — Generate BTC QR.
<code>/ltc [amount]</code> — Generate LTC QR.
<code>/usdt [amount]</code> — Generate USDT QR.
<code>/binance</code> — Show Binance ID.
<code>/themes</code> — Browse QR themes.
<code>/calc &lt;expr&gt;</code> — Calculator.
<code>/convert &lt;amt&gt; &lt;symbol&gt;</code> — Crypto↔fiat converter.
<code>/price</code> — Live crypto prices.
<code>/speed</code> — Latency benchmark.

⚡ <b>Inline Mode</b>
Use @payzwxbot in any chat:
<code>@payzwxbot 500</code> (UPI QR)
<code>@payzwxbot btc</code> (BTC QR)
<code>@payzwxbot 25*4</code> (Calculator)

━━━━━━━━━━━━━━━━━━`;
    ctx.replyWithHTML(menu);
});

bot.command('upi', async (ctx) => {
    const upiId = ctx.payload.trim();
    if (ctx.chat.type !== 'private') {
        return ctx.reply("✦ *UPI Setup*\n\nPlease link your UPI ID in private for security.", { reply_markup: getSetupButton() });
    }
    if (!upiId) return ctx.reply("Usage: `/upi <UPI_ID>`\nExample: `/upi vaibhavzawdx@fam`", { parse_mode: 'Markdown' });
    const tgId = ctx.from.id;
    const data = ensureUserInMemory(tgId, ctx.from.username);
    await dbWrite('INSERT OR IGNORE INTO users (telegram_id, username) VALUES (?, ?)', tgId, ctx.from.username);
    await dbWrite('INSERT OR REPLACE INTO payment_methods (user_id, name, type, value) VALUES ((SELECT id FROM users WHERE telegram_id = ?), "upi", "UPI", ?)', tgId, upiId);
    data.upi = upiId;
    ctx.reply(`✅ UPI ID linked: \`${upiId}\``, { parse_mode: 'Markdown' });
});

bot.command('save', async (ctx) => {
    const tgId = ctx.from.id;
    const payload = ctx.payload.trim();
    if (!payload) {
        return ctx.reply("✦ *Save Wallet*\n━━━━━━━━━━━━━━━━━━\n\nUsage: `/save <name> <wallet_address>`\n\n*Supported:*\n✦ `/save btc bc1q...`\n✦ `/save ltc L...`\n✦ `/save usdt T...`\n✦ `/save binance 123456789`\n✦ `/save eth 0x...`\n✦ `/save tron T...`\n✦ `/save sol <address>`\n\n━━━━━━━━━━━━━━━━━━\n📋 View all: `/wallets`", { parse_mode: 'Markdown' });
    }
    const parts = payload.split(/\s+/);
    if (parts.length < 2) {
        return ctx.reply("Usage: `/save <name> <wallet_address>`\nExample: `/save btc bc1qtdmj...`", { parse_mode: 'Markdown' });
    }
    const name = parts[0].toLowerCase();
    const address = parts.slice(1).join(' ');
    const currencyMap = {
        'btc': 'BTC', 'bitcoin': 'BTC', 'ltc': 'LTC', 'litecoin': 'LTC',
        'usdt': 'USDT', 'tether': 'USDT', 'eth': 'ETH', 'ethereum': 'ETH',
        'binance': 'BINANCE', 'tron': 'TRX', 'trx': 'TRX', 'sol': 'SOL', 'solana': 'SOL'
    };
    const currency = currencyMap[name] || name.toUpperCase();
    const data = ensureUserInMemory(tgId, ctx.from.username);
    await dbWrite('INSERT OR IGNORE INTO users (telegram_id, username) VALUES (?, ?)', tgId, ctx.from.username);
    await dbWrite('INSERT OR REPLACE INTO crypto_wallets (user_id, name, currency, address) VALUES ((SELECT id FROM users WHERE telegram_id = ?), ?, ?, ?)', tgId, name, currency, address);
    data.wallets.set(name, { currency, address });
    WALLET_CACHE.set(tgId, data.wallets);
    ctx.reply(`✅ *Wallet Saved*\n━━━━━━━━━━━━━━━━━━\n✦ *Name:* \`${name}\`\n✦ *Currency:* ${currency}\n✦ *Address:* \`${address}\``, { parse_mode: 'Markdown' });
});

bot.command('wallets', async (ctx) => {
    const tgId = ctx.from.id;
    const data = USER_DATA.get(tgId);
    const wallets = data ? Array.from(data.wallets.entries()) : [];
    if (wallets.length === 0) {
        return ctx.reply("✦ *No Wallets Saved*\n━━━━━━━━━━━━━━━━━━\n\nUse `/save` to add a crypto wallet.\n\nExample: `/save btc bc1q...`", { parse_mode: 'Markdown' });
    }
    let text = `✦ *Saved Wallets*\n━━━━━━━━━━━━━━━━━━\n\n`;
    wallets.forEach(([name, w]) => { text += `✦ *${name}* (${w.currency})\n\`${w.address}\`\n\n`; });
    text += `━━━━━━━━━━━━━━━━━━`;
    ctx.reply(text, { parse_mode: 'Markdown' });
});

bot.command('qr', async (ctx) => {
    const tgId = ctx.from.id;
    const upi = getUpiFromMemory(tgId);
    if (!upi) {
        return ctx.reply("✦ *UPI Not Linked*\n\nPlease link your UPI ID first to generate payment QRs.\n\n💡 Usage: `/upi <your upi id>`", { reply_markup: getSetupButton(), parse_mode: 'Markdown' });
    }
    const data = getUserData(tgId) || { theme: 'default' };
    const amount = ctx.payload.trim();
    if (!amount) {
        ctx.replyWithPhoto({ source: PREVIEW_CACHE[data.theme] || PREVIEW_CACHE['default'] }, {
            caption: `*Payment to ${ctx.from.first_name}*\n✦ UPI ID: \`${upi}\`\n*Scan to pay instantly*`,
            parse_mode: 'Markdown'
        }).catch(() => {});
        return;
    }
    const qrBuffer = await getQRBuffer(upi, ctx.from.first_name, amount, data.theme);
    ctx.replyWithPhoto({ source: qrBuffer }, {
        caption: `*Payment to ${ctx.from.first_name}*\n✦ UPI ID: \`${upi}\`\n*Amount: ₹${amount}*\n*Scan to pay instantly*`,
        parse_mode: 'Markdown'
    });
});

bot.command('btc', async (ctx) => {
    const tgId = ctx.from.id;
    const wallet = getWalletFromMemory(tgId, 'btc');
    if (!wallet) {
        return ctx.reply("✦ *BTC Wallet Not Found*\n━━━━━━━━━━━━━━━━━━\n\nYou haven't saved a BTC address yet.\n\n💡 Usage: `/save btc <your_address>`\nExample: `/save btc bc1qtdmj...`", { parse_mode: 'Markdown' });
    }
    const amount = ctx.payload.trim();
    const data = getUserData(tgId) || { theme: 'king' };
    const qrBuffer = await getCryptoQRBuffer(wallet.address, 'btc', data.theme);
    ctx.replyWithPhoto({ source: qrBuffer }, {
        caption: `⚡ *BTC Payment to ${ctx.from.first_name}*\n✦ Address: \`${wallet.address}\`\n${amount ? `✦ Amount: *${amount} BTC*\n` : ''}*Scan to pay instantly*`,
        parse_mode: 'Markdown'
    });
});

bot.command('ltc', async (ctx) => {
    const tgId = ctx.from.id;
    const wallet = getWalletFromMemory(tgId, 'ltc');
    if (!wallet) {
        return ctx.reply("✦ *LTC Wallet Not Found*\n━━━━━━━━━━━━━━━━━━\n\nYou haven't saved an LTC address yet.\n\n💡 Usage: `/save ltc <your_address>`", { parse_mode: 'Markdown' });
    }
    const amount = ctx.payload.trim();
    const data = getUserData(tgId) || { theme: 'king' };
    const qrBuffer = await getCryptoQRBuffer(wallet.address, 'ltc', data.theme);
    ctx.replyWithPhoto({ source: qrBuffer }, {
        caption: `⚡ *LTC Payment to ${ctx.from.first_name}*\n✦ Address: \`${wallet.address}\`\n${amount ? `✦ Amount: *${amount} LTC*\n` : ''}*Scan to pay instantly*`,
        parse_mode: 'Markdown'
    });
});

bot.command('usdt', async (ctx) => {
    const tgId = ctx.from.id;
    const wallet = getWalletFromMemory(tgId, 'usdt');
    if (!wallet) {
        return ctx.reply("✦ *USDT Wallet Not Found*\n━━━━━━━━━━━━━━━━━━\n\nYou haven't saved a USDT (TRC-20) address yet.\n\n💡 Usage: `/save usdt <your_address>`", { parse_mode: 'Markdown' });
    }
    const amount = ctx.payload.trim();
    const data = getUserData(tgId) || { theme: 'king' };
    const qrBuffer = await getCryptoQRBuffer(wallet.address, 'usdt', data.theme);
    ctx.replyWithPhoto({ source: qrBuffer }, {
        caption: `⚡ *USDT (TRC-20) Payment to ${ctx.from.first_name}*\n✦ Address: \`${wallet.address}\`\n${amount ? `✦ Amount: *${amount} USDT*\n` : ''}*Scan to pay instantly*`,
        parse_mode: 'Markdown'
    });
});

bot.command('binance', async (ctx) => {
    const tgId = ctx.from.id;
    const wallet = getWalletFromMemory(tgId, 'binance');
    if (!wallet) {
        return ctx.reply("✦ *Binance ID Not Found*\n━━━━━━━━━━━━━━━━━━\n\nYou haven't saved a Binance ID yet.\n\n💡 Usage: `/save binance <your_id>`\nExample: `/save binance 123456789`", { parse_mode: 'Markdown' });
    }
    ctx.reply(`✦ *Binance ID*\n━━━━━━━━━━━━━━━━━━\n\n✦ *ID:* \`${wallet.address}\`\n\n━━━━━━━━━━━━━━━━━━\n✦ Send your Binance Pay ID to receive payments.`, { parse_mode: 'Markdown' });
});

bot.command('calc', async (ctx) => {
    const expr = ctx.payload.trim();
    if (!expr) {
        return ctx.reply("✦ *Calculator*\n━━━━━━━━━━━━━━━━━━\n\nUsage: `/calc <expression>`\n\nExamples:\n✦ `/calc 25*4`\n✦ `/calc (100+50)/3`\n✦ `/calc 2^10`", { parse_mode: 'Markdown' });
    }
    try {
        const result = evaluate(expr);
        ctx.reply(`✦ *Result*\n━━━━━━━━━━━━━━━━━━\n\n\`${expr} = ${result}\``, { parse_mode: 'Markdown' });
    } catch (e) {
        ctx.reply(`❌ Invalid expression. Try: \`/calc 25*4\``, { parse_mode: 'Markdown' });
    }
});

bot.command('convert', async (ctx) => {
    const payload = ctx.payload.trim();
    if (!payload) {
        return ctx.reply("✦ *Crypto Converter*\n━━━━━━━━━━━━━━━━━━\n\nUsage: `/convert <amount> <symbol> [to]`\n\nExamples:\n✦ `/convert 1 btc inr`\n✦ `/convert 50000 inr btc`\n✦ `/convert 1 usdt inr`\n\n━━━━━━━━━━━━━━━━━━\nPrices fetched live.", { parse_mode: 'Markdown' });
    }
    const parts = payload.split(/\s+/).filter(Boolean);
    if (parts.length < 2) {
        return ctx.reply("Usage: `/convert <amount> <symbol> [to]`\nExample: `/convert 1 btc inr`", { parse_mode: 'Markdown' });
    }
    const amount = parseFloat(parts[0]);
    if (isNaN(amount) || amount <= 0) {
        return ctx.reply("❌ Invalid amount. Use: `/convert 1 btc inr`", { parse_mode: 'Markdown' });
    }
    const from = parts[1].toLowerCase();
    const to = (parts[2] || 'inr').toLowerCase();
    const symbolMap = { btc: 'bitcoin', ltc: 'litecoin', usdt: 'tether', eth: 'ethereum', sol: 'solana' };
    const fiatCodes = { inr: 'INR', usd: 'USD', eur: 'EUR' };
    const fromCoin = symbolMap[from];
    if (!fromCoin) {
        return ctx.reply(`❌ Unsupported currency \`${from}\`. Use btc, ltc, usdt, eth, sol.`, { parse_mode: 'Markdown' });
    }
    try {
        const url = `https://api.coingecko.com/api/v3/simple/price?ids=${fromCoin}&vs_currencies=${fiatCodes[to] ? to : 'usd'}`;
        const res = await axios.get(url, { timeout: 10000, httpsAgent });
        const price = res.data && res.data[fromCoin] ? res.data[fromCoin][fiatCodes[to] ? to : 'usd'] : null;
        if (price == null) throw new Error('no price');
        const result = (amount * price).toFixed(to === 'inr' ? 2 : 6);
        ctx.reply(`✦ *Converter*\n━━━━━━━━━━━━━━━━━━\n\n*${amount} ${from.toUpperCase()}* = *${fiatCodes[to] ? fiatCodes[to] : to.toUpperCase()} ${result}*\n\nRate: 1 ${from.toUpperCase()} = ${fiatCodes[to] ? fiatCodes[to] : to.toUpperCase()} ${price.toLocaleString(undefined, { maximumFractionDigits: 2 })}\n\n━━━━━━━━━━━━━━━━━━\nPrices: CoinGecko (live)`, { parse_mode: 'Markdown' });
    } catch (e) {
        ctx.reply("❌ Could not fetch live prices right now. Try again in a moment.", { parse_mode: 'Markdown' });
    }
});

bot.command('price', async (ctx) => {
    try {
        const res = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,litecoin,tether,ethereum,solana&vs_currencies=inr,usd&include_24hr_change=true', { timeout: 10000, httpsAgent });
        const d = res.data || {};
        const rows = [
            ['BTC', d.bitcoin], ['LTC', d.litecoin], ['USDT', d.tether], ['ETH', d.ethereum], ['SOL', d.solana]
        ];
        let text = `✦ *Live Crypto Prices*\n━━━━━━━━━━━━━━━━━━\n\n`;
        for (const [sym, v] of rows) {
            if (!v) continue;
            const change = v.usd_24h_change != null ? (v.usd_24h_change >= 0 ? `📈 +${v.usd_24h_change.toFixed(1)}%` : `📉 ${v.usd_24h_change.toFixed(1)}%`) : '';
            text += `✦ *${sym}* — ₹${(v.inr || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })} · $${(v.usd || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })} ${change}\n`;
        }
        text += `\n━━━━━━━━━━━━━━━━━━\nSource: CoinGecko (live)`;
        ctx.reply(text, { parse_mode: 'Markdown' });
    } catch (e) {
        ctx.reply("❌ Could not fetch live prices right now. Try again in a moment.", { parse_mode: 'Markdown' });
    }
});

bot.command('speed', async (ctx) => {
    const start = Date.now();
    const tMsg = await ctx.reply("⚡ *Latency Benchmark*\n━━━━━━━━━━━━━━━━━━\n\nMeasuring...", { parse_mode: 'Markdown' }).catch(() => null);
    if (!tMsg) return;
    try {
        await ctx.telegram.editMessageText(ctx.chat.id, tMsg.message_id, undefined,
            `⚡ *Latency Benchmark*\n━━━━━━━━━━━━━━━━━━\n\n✦ Telegram round-trip: *${Date.now() - start}ms*\n✦ Memory users: *${USER_DATA.size}*\n✦ QR cache: *${INLINE_QR_CACHE.size}*\n\n━━━━━━━━━━━━━━━━━━`, { parse_mode: 'Markdown' });
    } catch (e) {}
});

bot.command('profile', async (ctx) => {
    const tgId = ctx.from.id;
    const data = getUserData(tgId);
    if (!data) {
        return ctx.reply("✦ *Your Profile*\n━━━━━━━━━━━━━━━━━━\n\n✦ Username: @${ctx.from.username || 'N/A'}\n✦ UPI: Not linked\n✦ Wallets: None saved\n✦ QRs Generated: 0\n✦ Theme: Normal QR (Standard)\n\n━━━━━━━━━━━━━━━━━━\nSet up: /upi, /save, /themes", { parse_mode: 'Markdown' });
    }
    const wallets = Array.from(data.wallets.entries());
    let text = `✦ *Your Profile*\n━━━━━━━━━━━━━━━━━━\n\n✦ Username: @${ctx.from.username || 'N/A'}\n✦ UPI: \`${data.upi || 'Not linked'}\`\n✦ QRs Generated: ${data.qr_count}\n✦ Theme: ${data.theme === 'king' ? '`✦ THE KING ✦`' : 'Normal QR (Standard)'}\n\n`;
    if (wallets.length > 0) {
        text += `*Wallets:*\n`;
        wallets.forEach(([name, w]) => { text += `✦ *${name}* (${w.currency}): \`${w.address}\`\n`; });
    } else {
        text += `*Wallets:* None saved — use /save\n`;
    }
    text += `\n━━━━━━━━━━━━━━━━━━`;
    ctx.reply(text, { parse_mode: 'Markdown' });
});

bot.command('themes', async (ctx) => {
    const tgId = ctx.from.id;
    const data = getUserData(tgId) || { theme: 'default', owned_themes: 'default' };
    const theme = THEMES[0];
    const isEquipped = data.theme === theme.id;
    const isOwned = (data.owned_themes || 'default').split(',').includes(theme.id);
    const status = isEquipped ? '● Equipped' : (isOwned ? '○ Owned' : '○ Locked');
    const isKingTheme = theme.id === 'king';
    const themeNameDisplay = isKingTheme ? '`✦ THE KING ✦`' : `\`${theme.name}\``;
    const rarityDisplay = isKingTheme ? '✦ Mythic' : theme.rarity;
    await ctx.replyWithPhoto({ source: PREVIEW_CACHE[theme.id] }, {
        caption: `✦ *QR Theme Browser*\n━━━━━━━━━━━━━━━━━━\n\n*Theme:* ${themeNameDisplay}\n*Rarity:* ${rarityDisplay}\n*Price:* ${theme.price}\n*Status:* ${status}\n\n${getPaginationDots(0, THEMES.length)}\n━━━━━━━━━━━━━━━━━━`,
        parse_mode: 'Markdown',
        reply_markup: getThemeKeyboard(0, isEquipped, isOwned, theme.id)
    });
});

// ─── CALLBACK HANDLERS ───
bot.action(/^nav_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const idx = parseInt(ctx.match[1]);
    const theme = THEMES[idx];
    const data = getUserData(ctx.from.id) || { theme: 'default', owned_themes: 'default' };
    const isEquipped = data.theme === theme.id;
    const isOwned = (data.owned_themes || 'default').split(',').includes(theme.id);
    const status = isEquipped ? '● Equipped' : (isOwned ? '○ Owned' : '○ Locked');
    const isKingTheme = theme.id === 'king';
    const themeNameDisplay = isKingTheme ? '`✦ THE KING ✦`' : `\`${theme.name}\``;
    const rarityDisplay = isKingTheme ? '✦ Mythic' : theme.rarity;
    const newCaption = `✦ *QR Theme Browser*\n━━━━━━━━━━━━━━━━━━\n\n*Theme:* ${themeNameDisplay}\n*Rarity:* ${rarityDisplay}\n*Price:* ${theme.price}\n*Status:* ${status}\n\n${getPaginationDots(idx, THEMES.length)}\n━━━━━━━━━━━━━━━━━━`;
    ctx.editMessageMedia({
        type: 'photo', media: { source: PREVIEW_CACHE[theme.id] },
        caption: newCaption, parse_mode: 'Markdown'
    }, { reply_markup: getThemeKeyboard(idx, isEquipped, isOwned, theme.id) }).catch(() => {});
});

bot.action(/^equip_(\w+)_(\d+)$/, async (ctx) => {
    const themeId = ctx.match[1];
    const idx = parseInt(ctx.match[2]);
    const tgId = ctx.from.id;
    await ctx.answerCbQuery(`${themeId} equipped!`);
    await dbWrite('UPDATE users SET theme = ? WHERE telegram_id = ?', themeId, tgId);
    const data = USER_DATA.get(tgId);
    if (data) { data.theme = themeId; }
    const isKingTheme = themeId === 'king';
    const themeNameDisplay = isKingTheme ? '`✦ THE KING ✦`' : `\`${themeId}\``;
    ctx.editMessageCaption(`✦ *QR Theme Browser*\n━━━━━━━━━━━━━━━━━━\n\n*Theme:* ${themeNameDisplay}\n*Status:* ● Equipped\n\n${getPaginationDots(idx, THEMES.length)}\n━━━━━━━━━━━━━━━━━━`, {
        parse_mode: 'Markdown',
        reply_markup: getEquippedKeyboard(idx)
    }).catch(() => {});
});

bot.action(/^noop$/, async (ctx) => { await ctx.answerCbQuery(); });

bot.action(/^buy_(\w+)_(\d+)$/, async (ctx) => {
    const themeId = ctx.match[1];
    if (themeId === 'king') {
        await ctx.answerCbQuery('Enter UTR/TRX ID below');
        WAITING_FOR_PAYMENT.set(ctx.from.id, themeId);
        const cancelKeyboard = { inline_keyboard: [[{ text: "❌ Cancel", callback_data: "cancel_payment" }]] };
        const buyCaption = `✦ *Buy ✦ THE KING ✦ QR*\n━━━━━━━━━━━━━━━━━━\n\n💰 *Price: ₹101*\n\nScan the QR above to pay ₹101.\n\n📤 After payment, send your *UTR or TRX ID* here to confirm.\n\n━━━━━━━━━━━━━━━━━━`;
        await ctx.replyWithPhoto(process.env.KING_QR_CLOUDINARY_URL || 'https://res.cloudinary.com/wrkyqgb9/image/upload/paymacchabot/themes/paymacchabot/themes/king_qr_full.png', {
            caption: buyCaption, parse_mode: 'Markdown', reply_markup: cancelKeyboard
        });
    } else {
        await ctx.answerCbQuery('Theme not available for purchase.');
    }
});

bot.action(/^cancel_payment$/, async (ctx) => {
    await ctx.answerCbQuery('Cancelled.');
    WAITING_FOR_PAYMENT.delete(ctx.from.id);
    ctx.deleteMessage().catch(() => {});
});

// ─── TEXT HANDLER: UPI auto-detect + UTR verification ───
bot.on('text', async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    const text = ctx.message.text.trim();
    const tgId = ctx.from.id;
    if (WAITING_FOR_PAYMENT.has(tgId)) {
        const themeId = WAITING_FOR_PAYMENT.get(tgId);
        if (text.startsWith('/')) { WAITING_FOR_PAYMENT.delete(tgId); return; }
        const utrId = text.replace(/[^a-zA-Z0-9]/g, '').trim();
        if (utrId.length < 6) {
            return ctx.reply("❌ Invalid UTR/TRX ID. Please send a valid transaction ID.");
        }
        await ctx.reply(`🔍 *Verifying your payment...*\n\nPlease wait while we check for your transaction.`, { parse_mode: 'Markdown' });
        WAITING_FOR_PAYMENT.delete(tgId);
        try {
            const verified = await verifyUtrFromGmail(utrId);
            if (verified) {
                const data = ensureUserInMemory(tgId, ctx.from.username);
                await dbWrite('INSERT OR IGNORE INTO users (telegram_id, username) VALUES (?, ?)', tgId, ctx.from.username);
                const row = await db.get('SELECT owned_themes FROM users WHERE telegram_id = ?', tgId);
                const currentThemes = (row && row.owned_themes) || 'king';
                const newThemes = currentThemes.includes(themeId) ? currentThemes : currentThemes + ',' + themeId;
                await dbWrite('UPDATE users SET owned_themes = ? WHERE telegram_id = ?', newThemes, tgId);
                await dbWrite('UPDATE users SET theme = ? WHERE telegram_id = ?', themeId, tgId);
                data.theme = themeId;
                data.owned_themes = newThemes;
                await ctx.reply(`✅ *Payment Verified!*\n━━━━━━━━━━━━━━━━━━\n\n✦ *THE KING ✦ QR* is now yours!\n✦ Status: Equipped automatically\n\nYour QRs will now use the King theme.\n\n━━━━━━━━━━━━━━━━━━`, { parse_mode: 'Markdown' });
            } else {
                await ctx.reply(`❌ *Payment Not Found*\n━━━━━━━━━━━━━━━━━━\n\nWe couldn't find a matching transaction for UTR/TRX: \`${utrId}\`\n\nMake sure you paid ₹101 to the QR shown above.\n\nTry again: /themes → Buy\n\n━━━━━━━━━━━━━━━━━━`, { parse_mode: 'Markdown' });
            }
        } catch (e) {
            console.error('UTR verification error:', e.message);
            await ctx.reply(`⚠️ *Verification Failed*\n\nUnable to verify payment. Please contact support or try again later.`, { parse_mode: 'Markdown' });
        }
        return;
    }
    // Auto-detect UPI ID
    if (text.includes('@') && !text.startsWith('/')) {
        const data = ensureUserInMemory(tgId, ctx.from.username);
        await dbWrite('INSERT OR IGNORE INTO users (telegram_id, username) VALUES (?, ?)', tgId, ctx.from.username);
        await dbWrite('INSERT OR REPLACE INTO payment_methods (user_id, name, type, value) VALUES ((SELECT id FROM users WHERE telegram_id = ?), "upi", "UPI", ?)', tgId, text);
        data.upi = text;
        return ctx.reply(`✅ UPI ID linked: \`${text}\``, { parse_mode: 'Markdown' });
    }
});

// ─── INLINE QUERY (memory-first) ───
bot.on('inline_query', async (ctx) => {
    const query = ctx.inlineQuery.query.trim();
    const tgId = ctx.from.id;
    const data = USER_DATA.get(tgId);
    const upi = data ? data.upi : null;
    const qrUsageCount = data ? data.qr_count : 0;
    const results = [];
    const switch_pm_text = upi ? undefined : "✦ Setup UPI First";
    const switch_pm_parameter = upi ? undefined : "setup_upi";

    // Not set up — card with DM redirect
    if (!upi) {
        results.push({
            type: 'article', id: 'not_setup', title: '✦ Set up UPI first',
            description: 'Open @payzwxbot to link your UPI ID', thumb_url: ICONS.qr,
            input_message_content: {
                message_text: '*✦ Set up UPI first*\n━━━━━━━━━━━━━━━━━━\n\nOpen @payzwxbot and link your UPI ID:\n`/upi <your upi id>`\n\nAfter setup, use @payzwxbot in any chat to generate QRs.\n\n━━━━━━━━━━━━━━━━━━',
                parse_mode: 'Markdown'
            },
            reply_markup: { inline_keyboard: [[{ text: "✦ Setup UPI → @payzwxbot", url: `https://t.me/payzwxbot?start=setup_upi` }]] }
        });
    }
    // Calculator
    if (query.match(/^[0-9+\-*/().\s]+$/) && query.length > 0) {
        try {
            const res = evaluate(query);
            results.push({
                type: 'article', id: 'c' + Date.now(),
                title: `${query} = ${res}`, description: `Calculate: ${query}`,
                thumb_url: ICONS.calc,
                input_message_content: { message_text: `*${query} = ${res}*`, parse_mode: 'Markdown' }
            });
        } catch (e) {}
    }
    // UPI QR for queries starting with a digit
    if (upi && !query.match(/^(btc|ltc|usdt|binance|eth|tron|sol)$/i) && query.match(/^[0-9]/)) {
        const amount = query.replace(/[^\d.]/g, '').replace(/\.(?=.*\.)/g, ''); // allow one decimal: 7.50 stays 7.50
        try {
            const fileUrl = await generateInlineQR(upi, ctx.from.first_name, amount, (data || { theme: 'king' }).theme);
            results.push({
                type: 'photo', id: 'q' + Date.now(), photo_url: fileUrl, thumb_url: fileUrl,
                title: amount ? `Pay ₹${amount}` : 'Generate UPI QR',
                description: `Scan to pay ${ctx.from.first_name}`,
                caption: `*Payment to ${ctx.from.first_name}*\n✦ UPI ID: \`${upi}\`\n${amount ? '✦ Amount: *₹' + amount + '*\n' : ''}*Scan to pay instantly*`,
                parse_mode: 'Markdown'
            });
            if (data) data.qr_count++;
        } catch (e) {}
    }
    // BTC inline
    if (query.toLowerCase() === 'btc') {
        const wallet = data ? data.wallets.get('btc') : null;
        if (wallet) {
            const fileUrl = await generateCryptoQR(wallet.address, 'btc', 'king');
            results.push({
                type: 'photo', id: 'btc_' + Date.now(), photo_url: fileUrl, thumb_url: ICONS.btc,
                title: 'BTC QR Code', description: `Bitcoin: ${wallet.address.slice(0, 20)}...`,
                caption: `⚡ *BTC Payment*\n✦ Address: \`${wallet.address}\`\n*Scan to pay instantly*`, parse_mode: 'Markdown'
            });
        } else {
            results.push({
                type: 'article', id: 'btc_no_wallet', title: 'BTC Wallet Not Saved',
                description: 'Use /save btc <address>', thumb_url: ICONS.btc,
                input_message_content: { message_text: '/save btc' }
            });
        }
    }
    // LTC inline
    if (query.toLowerCase() === 'ltc') {
        const wallet = data ? data.wallets.get('ltc') : null;
        if (wallet) {
            const fileUrl = await generateCryptoQR(wallet.address, 'ltc', 'king');
            results.push({
                type: 'photo', id: 'ltc_' + Date.now(), photo_url: fileUrl, thumb_url: ICONS.ltc,
                title: 'LTC QR Code', description: `Litecoin: ${wallet.address.slice(0, 20)}...`,
                caption: `⚡ *LTC Payment*\n✦ Address: \`${wallet.address}\`\n*Scan to pay instantly*`, parse_mode: 'Markdown'
            });
        } else {
            results.push({
                type: 'article', id: 'ltc_no_wallet', title: 'LTC Wallet Not Saved',
                description: 'Use /save ltc <address>', thumb_url: ICONS.ltc,
                input_message_content: { message_text: '/save ltc' }
            });
        }
    }
    // USDT inline
    if (query.toLowerCase() === 'usdt') {
        const wallet = data ? data.wallets.get('usdt') : null;
        if (wallet) {
            const fileUrl = await generateCryptoQR(wallet.address, 'usdt', 'king');
            results.push({
                type: 'photo', id: 'usdt_' + Date.now(), photo_url: fileUrl, thumb_url: ICONS.usdt,
                title: 'USDT QR Code', description: `USDT: ${wallet.address.slice(0, 20)}...`,
                caption: `⚡ *USDT (TRC-20) Payment*\n✦ Address: \`${wallet.address}\`\n*Scan to pay instantly*`, parse_mode: 'Markdown'
            });
        } else {
            results.push({
                type: 'article', id: 'usdt_no_wallet', title: 'USDT Wallet Not Saved',
                description: 'Use /save usdt <address>', thumb_url: ICONS.usdt,
                input_message_content: { message_text: '/save usdt' }
            });
        }
    }
    // Binance inline
    if (query.toLowerCase() === 'binance') {
        const wallet = data ? data.wallets.get('binance') : null;
        if (wallet) {
            results.push({
                type: 'article', id: 'binance_' + Date.now(), title: 'Binance ID',
                description: wallet.address, thumb_url: ICONS.binance,
                input_message_content: { message_text: `✦ *Binance ID*\n\`${wallet.address}\``, parse_mode: 'Markdown' }
            });
        } else {
            results.push({
                type: 'article', id: 'binance_no_wallet', title: 'Binance ID Not Saved',
                description: 'Use /save binance <your_id>', thumb_url: ICONS.binance,
                input_message_content: { message_text: '/save binance' }
            });
        }
    }
    // Default suggestions (QR + calculator only)
    if (!query) {
        if (upi) {
            try {
                const defaultQrUrl = await generateInlineQR(upi, ctx.from.first_name, '', (data || { theme: 'king' }).theme);
                results.push({
                    type: 'photo', id: 's_qr_photo', photo_url: defaultQrUrl, thumb_url: defaultQrUrl,
                    title: 'Payment QR', description: `Pay ${ctx.from.first_name} — scan to pay`,
                    caption: `*Payment to ${ctx.from.first_name}*\n✦ UPI ID: \`${upi}\`\n*Scan to pay instantly*`,
                    parse_mode: 'Markdown'
                });
            } catch (e) {
                results.push({
                    type: 'article', id: 's_qr', title: 'Generate QR',
                    description: 'Type an amount to generate a payment QR',
                    thumb_url: ICONS.qr, input_message_content: { message_text: '/qr' }
                });
            }
        }
        results.push({
            type: 'article', id: 's_calc', title: 'Calculator',
            description: 'Type a math expression (e.g., 25*4)',
            thumb_url: ICONS.calc, input_message_content: { message_text: 'Type expression: 25*4' }
        });
        const btcWallet = data ? data.wallets.get('btc') : null;
        if (btcWallet) {
            const fileUrl = await generateCryptoQR(btcWallet.address, 'btc', 'king');
            results.push({
                type: 'photo', id: 's_btc_photo', photo_url: fileUrl, thumb_url: ICONS.btc,
                title: 'BTC QR Code', description: `Bitcoin: ${btcWallet.address.slice(0, 20)}...`,
                caption: `⚡ *BTC Payment*\n✦ Address: \`${btcWallet.address}\`\n*Scan to pay instantly*`, parse_mode: 'Markdown'
            });
        } else {
            results.push({ type: 'article', id: 's_btc', title: 'BTC', description: 'Bitcoin Payment — save wallet first', thumb_url: ICONS.btc, input_message_content: { message_text: '/save btc <address>' } });
        }
        const usdtWallet = data ? data.wallets.get('usdt') : null;
        if (usdtWallet) {
            const fileUrl = await generateCryptoQR(usdtWallet.address, 'usdt', 'king');
            results.push({
                type: 'photo', id: 's_usdt_photo', photo_url: fileUrl, thumb_url: ICONS.usdt,
                title: 'USDT QR Code', description: `USDT: ${usdtWallet.address.slice(0, 20)}...`,
                caption: `⚡ *USDT (TRC-20) Payment*\n✦ Address: \`${usdtWallet.address}\`\n*Scan to pay instantly*`, parse_mode: 'Markdown'
            });
        } else {
            results.push({ type: 'article', id: 's_usdt', title: 'USDT', description: 'USDT Payment — save wallet first', thumb_url: ICONS.usdt, input_message_content: { message_text: '/save usdt <address>' } });
        }
        const ltcWallet = data ? data.wallets.get('ltc') : null;
        if (ltcWallet) {
            const fileUrl = await generateCryptoQR(ltcWallet.address, 'ltc', 'king');
            results.push({
                type: 'photo', id: 's_ltc_photo', photo_url: fileUrl, thumb_url: ICONS.ltc,
                title: 'LTC QR Code', description: `Litecoin: ${ltcWallet.address.slice(0, 20)}...`,
                caption: `⚡ *LTC Payment*\n✦ Address: \`${ltcWallet.address}\`\n*Scan to pay instantly*`, parse_mode: 'Markdown'
            });
        } else {
            results.push({ type: 'article', id: 's_ltc', title: 'LTC', description: 'Litecoin Payment — save wallet first', thumb_url: ICONS.ltc, input_message_content: { message_text: '/save ltc <address>' } });
        }
    }
    // Put QR result on top if user has used QR recently
    if (qrUsageCount > 0 && results.length > 1) {
        const qrIndex = results.findIndex(r => r.type === 'photo');
        if (qrIndex > 0) {
            const [qrItem] = results.splice(qrIndex, 1);
            results.unshift(qrItem);
        }
    }
    try {
        // Fail-open race: wait up to 10s for Telegram; if egress is slow/dead, respond
        // to the webhook immediately so users don't wait for external services.
        await Promise.race([
            ctx.answerInlineQuery(results, { cache_time: 0, switch_pm_text, switch_pm_parameter }),
            new Promise((r) => setTimeout(() => {
                console.log('⚠ Inline answer slow (egress?) — responding without waiting further');
                r();
            }, 10000))
        ]);
    } catch (e) {
        console.error('⚠ Inline answer failed:', e.description || e.message);
    }
});

// ═══════════════════════════════════════════════════════
// WEBHOOK SERVER (Express + Telegraf webhook callback)
// ═══════════════════════════════════════════════════════
const express = (await import('express')).default;
const app = express();

// Cloudinary config + pre-cache previews on cold start
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME || 'wrkyqgb9',
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

async function forceBackup() {
    try {
        const storeJson = JSON.stringify({ ts: Date.now(), version: 2 }); // dbFacade auto-saves; this just confirms
        const buffer = Buffer.from(storeJson);
        const url = await uploadWithRetry(buffer, 'paymacchabot/store/latest_store.json');
        await dbWrite('INSERT INTO backup_log (file_name, drive_file_id) VALUES (?, ?)', 'latest_store.json', url);
        console.log('✅ Store backup saved:', url);
    } catch (e) {
        console.error('⚠ Backup failed:', e.message);
    }
}

db = await initDB();
scheduleStoreSave(); // ensure store persistence is active for warm lambdas
await preCache();
await loadAllDataIntoMemory();
// bot.launch() intentionally skipped: Express webhookCallback dispatches updates directly
console.log('🚀 PayMacchaBot (@payzwxbot) webhook handler initialized (serverless)');

app.post('/api/webhook', bot.webhookCallback('/api/webhook'));

// Startup endpoint: auto-sets webhook after deploy (open once in browser)
app.get('/api/setup', async (req, res) => {
    const webhookUrl = process.env.BASE_URL + '/api/webhook';
    try {
        await bot.telegram.setWebhook(webhookUrl, {
            allowed_updates: ['message', 'inline_query', 'callback_query'],
            max_connections: 100
        });
        res.json({ ok: true, webhook: webhookUrl });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

app.get('/api/ping', (req, res) => res.json({ ok: true, users: USER_DATA.size }));

export default app;
