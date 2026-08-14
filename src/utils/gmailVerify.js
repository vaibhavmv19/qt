import Imap from 'imap';
import { simpleParser } from 'mailparser';

/**
 * Verify a UTR/TRX ID by checking Gmail inbox for matching transaction IDs
 * Only checks emails from @famapp.in domain
 * 
 * @param {string} utrPid - The UTR or TRX ID to verify
 * @returns {Promise<boolean>} - True if a matching transaction email is found
 */
export async function verifyUtrFromGmail(utrId) {
    return new Promise((resolve, reject) => {
        const imap = new Imap({
            user: process.env.GMAIL_ADDRESS,
            password: process.env.GMAIL_APP_PASSWORD,
            host: 'imap.gmail.com',
            port: 993,
            tls: true,
            tlsOptions: { rejectUnauthorized: false }
        });

        let resolved = false;

        imap.once('ready', () => {
            imap.openBox('INBOX', true, (err) => {
                if (err) {
                    if (!resolved) { resolved = true; reject(err); }
                    return;
                }

                // Search last 50 emails from @famapp.in
                imap.search(['FROM', '@famapp.in', ['OR', 'FROM', 'noreply@famapp.in']], (err, results) => {
                    if (err) {
                        imap.end();
                        if (!resolved) { resolved = true; reject(err); }
                        return;
                    }

                    if (!results || results.length === 0) {
                        imap.end();
                        if (!resolved) { resolved = true; resolve(false); }
                        return;
                    }

                    const fetch = imap.fetch(results.slice(-50), { bodies: '' });
                    let found = false;

                    fetch.on('message', (msg) => {
                        msg.on('body', (stream) => {
                            let raw = '';
                            stream.on('data', (chunk) => { raw += chunk.toString('utf8'); });
                            stream.once('end', async () => {
                                try {
                                    const parsed = await simpleParser(raw);
                                    const subject = (parsed.subject || '').toLowerCase();
                                    const body = (parsed.text || '').toLowerCase();
                                    const utrLower = utrId.toLowerCase().trim();

                                    // Check if UTR/TRX ID appears in subject or body
                                    if (body.includes(utrLower) || subject.includes(utrLower)) {
                                        found = true;
                                    }
                                } catch (e) {
                                    console.error('Parse error:', e.message);
                                }
                            });
                        });
                    });

                    fetch.once('end', () => {
                        imap.end();
                        if (!resolved) { resolved = true; resolve(found); }
                    });
                });
            });
        });

        imap.once('error', (err) => {
            if (!resolved) { resolved = true; reject(err); }
        });

        imap.connect();

        // Timeout after 15 seconds
        setTimeout(() => {
            if (!resolved) {
                resolved = true;
                try { imap.end(); } catch (e) {}
                resolve(false);
            }
        }, 15000);
    });
}
