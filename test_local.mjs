// Local test of the Vercel webhook handler: boot the app, hit /api/ping,
// POST a fake /start update, and render one QR to verify the pipeline.
import app from './api/webhook.js';

const port = 8877;
await new Promise(resolve => app.listen(port, resolve));
console.log(`test server on :${port}`);

// 1. Health
const ping = await fetch(`http://localhost:${port}/api/ping`);
console.log('ping:', await ping.json());

// 2. Simulate /start update
const update = {
    update_id: 1,
    message: {
        message_id: 1,
        chat: { id: 123456789, type: 'private' },
        from: { id: 123456789, username: 'testuser', first_name: 'Tester', is_bot: false },
        text: '/start',
        entities: [{ type: 'bot_command', offset: 0, length: 6 }]
    }
};
const resp = await fetch(`http://localhost:${port}/api/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(update)
});
const body = await resp.text();
console.log('webhook status:', resp.status, '| body starts:', body.slice(0, 120));

// 3. QR render pipeline test
import { generateQRBuffer, createUpiQrData } from './src/utils/qrGenerator.js';
const t0 = Date.now();
const buf = await generateQRBuffer(createUpiQrData('test@fam', 'Tester', '500'), 'king');
console.log(`silver QR rendered in ${Date.now() - t0}ms, bytes: ${buf.length}`);

process.exit(0);
