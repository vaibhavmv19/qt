import { spawn } from 'child_process';
import { createConnection } from 'net';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PYTHON = process.env.PYTHON || 'python3';
const DISPATCHER_PORT = 9765;
const WORKER_BASE_PORT = 9770;
const WORKER_PORTS = [9770, 9771, 9772, 9773, 9774, 9775, 9776, 9777];
const SERVER_TIMEOUT = 30000;
const PROBE_TIMEOUT = 800;

// Pool mode: dispatcher + workers available (round-robin across workers directly)
let poolMode = null; // null = unknown; true/false
let workerRoundRobin = 0;

let renderBoot = null; // singleton: pool booted once per serverless instance

/** Start the worker pool (dispatcher + 4 workers) if not already reachable. */
async function ensureRenderPool() {
    if (renderBoot) return renderBoot;
    renderBoot = (async () => {
        try {
            if (await probePort(DISPATCHER_PORT, 400)) return; // already up
            const poolScript = path.resolve(__dirname, 'liquidQr_pool.py');
            const proc = spawn(PYTHON, [poolScript, '4'], {
                stdio: ['ignore', 'ignore', 'ignore'], detached: true
            });
            proc.unref(); // don't block serverless process exit
            for (let i = 0; i < 60; i++) {
                await new Promise((r) => setTimeout(r, 1000));
                if (await probePort(DISPATCHER_PORT, 400)) { console.log('liquidQr pool ready'); return; }
            }
            console.log('liquidQr pool not ready — falling back to spawn mode');
        } catch (e) {
            console.log('liquidQr pool boot error:', e.message);
        }
    })();
}

/** Check if a TCP port is reachable. */
function probePort(port, timeoutMs = PROBE_TIMEOUT) {
    return new Promise((resolve) => {
        const sock = createConnection({ host: '127.0.0.1', port });
        const timer = setTimeout(() => { sock.destroy(); resolve(false); }, timeoutMs);
        sock.on('connect', () => { clearTimeout(timer); sock.destroy(); resolve(true); });
        sock.on('error', () => { clearTimeout(timer); resolve(false); });
    });
}

/** Single-render request to any server port: JSON line -> base64 PNG + DONE. */
function renderViaPort(port, data, theme) {
    return new Promise((resolve, reject) => {
        const sock = createConnection({ host: '127.0.0.1', port });
        const timer = setTimeout(() => { sock.destroy(); reject(new Error('render timeout')); }, SERVER_TIMEOUT);
        let buf = '';
        sock.on('data', (chunk) => {
            buf += chunk.toString();
            const doneIdx = buf.indexOf('\nDONE\n');
            if (doneIdx !== -1) {
                clearTimeout(timer);
                resolve(Buffer.from(buf.slice(0, doneIdx), 'base64'));
            }
        });
        sock.on('error', (e) => { clearTimeout(timer); reject(e); });
        sock.write(JSON.stringify({ data, theme: theme || 'silver' }) + '\n');
    });
}

/** Round-robin across live worker ports (fastest: each worker is a full thread pool). */
async function renderViaPool(data, theme) {
    // Refresh worker availability periodically
    if (poolMode === null || Math.random() < 0.05) {
        const up = [];
        for (const port of WORKER_PORTS) {
            if (await probePort(port, 400)) up.push(port);
        }
        poolMode = up.length > 0;
        // keep round-robin offset within live workers
    }
    if (!poolMode) throw new Error('no pool workers');
    const up = WORKER_PORTS.filter(() => true);
    // pick next live worker round-robin style
    for (let attempt = 0; attempt < up.length; attempt++) {
        const port = WORKER_PORTS[workerRoundRobin++ % WORKER_PORTS.length];
        try {
            return await renderViaPort(port, data, theme);
        } catch (e) {
            if (attempt === up.length - 1) throw e;
        }
    }
    throw new Error('pool exhausted');
}

/** Fallback: dispatch through the pool dispatcher (round-robin managed by python). */
async function renderViaDispatcher(data, theme) {
    return await renderViaPort(DISPATCHER_PORT, data, theme);
}

/** Fallback: spawn a one-shot python3 renderer process. */
function renderViaSpawn(data, theme, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
        const script = path.resolve(__dirname, 'liquidQr.py');
        const proc = spawn(PYTHON, [script, data, 'b64', theme], { timeout: timeoutMs });
        let out = '';
        let err = '';
        proc.stdout.on('data', (chunk) => { out += chunk.toString(); });
        proc.stderr.on('data', (chunk) => { err += chunk.toString(); });
        proc.on('error', (e) => reject(new Error(`liquidQr spawn failed: ${e.message}`)));
        proc.on('close', (code) => {
            if (code !== 0 || !out.trim()) {
                return reject(new Error(`liquidQr.py exited ${code}: ${err.slice(0, 500)}`));
            }
            resolve(Buffer.from(out.trim(), 'base64'));
        });
    });
}

/**
 * Generate a silver liquid-style QR via the tuned Python renderer (liquidQr.py).
 * Preferred path: worker pool (parallel processes, GIL-free) via direct worker ports
 * or the dispatcher. Falls back to one-shot spawn.
 * Returns: Buffer (PNG)
 */
export async function generateLiquidQrBuffer(data, theme = 'silver') {
    // 0. Ensure the pool is booting (once per instance)
    ensureRenderPool();
    // 1. Pool workers (parallel, fastest under concurrency)
    try {
        return await renderViaPool(data, theme);
    } catch (e) { /* fall through */ }
    // 2. Dispatcher (single-process round-robin)
    try {
        if (await probePort(DISPATCHER_PORT, PROBE_TIMEOUT)) {
            return await renderViaDispatcher(data, theme);
        }
    } catch (e) { /* fall through */ }
    // 3. One-shot spawn (slowest, always available)
    return await renderViaSpawn(data, theme);
}
