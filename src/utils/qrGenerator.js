import QRCode from 'qrcode';
import { createCanvas, Image } from 'canvas';
import fs from 'fs';
import path from 'path';
import { generateLiquidQrBuffer } from './liquidQrNode.js';

// ═══════════════════════════════════════════════════════
// NATIVE NODE.JS QR GENERATION (NO PYTHON SUBPROCESS)
// Millisecond-speed QR generation
// ═══════════════════════════════════════════════════════

const QR_SIZE = 400;

/**
 * Generate a themed QR code image as PNG buffer
 * theme: 'king' | 'default'
 * Returns: Buffer (PNG)
 */
// Universal silver theme: ALL QRs render with the silver liquid style,
// regardless of the user's equipped theme.
export async function generateQRBuffer(data, theme = 'king') {
    // Universal silver liquid style: every QR, all users, all themes.
    try {
        return await generateLiquidQrBuffer(data, 'silver');
    } catch (e) {
        console.error('⚠ Liquid QR fallback to basic render:', e.message);
        return await QRCode.toBuffer(data, {
            width: QR_SIZE,
            margin: 4,
            color: { dark: '#000000', light: '#FFFFFF' },
            errorCorrectionLevel: 'M'
        });
    }
}

/**
 * Apply king theme: gold border, subtle glow, center logo
 */
async function applyKingTheme(qrBuffer) {
    const canvas = createCanvas(QR_SIZE, QR_SIZE);
    const ctx = canvas.getContext('2d');

    // Draw QR first
    const img = new Image();
    await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
        img.src = qrBuffer;
    });
    ctx.drawImage(img, 0, 0, QR_SIZE, QR_SIZE);

    // Add gold border (thick, premium look)
    ctx.strokeStyle = '#FFD700';
    ctx.lineWidth = 6;
    ctx.strokeRect(6, 6, QR_SIZE - 12, QR_SIZE - 12);

    // Add subtle gold glow effect on border
    ctx.shadowColor = '#FFD700';
    ctx.shadowBlur = 10;
    ctx.strokeStyle = 'rgba(255, 215, 0, 0.5)';
    ctx.lineWidth = 2;
    ctx.strokeRect(3, 3, QR_SIZE - 6, QR_SIZE - 6);
    ctx.shadowBlur = 0;

    // Add corner decorations (gold L-shapes)
    const cornerSize = 25;
    ctx.strokeStyle = '#FFD700';
    ctx.lineWidth = 4;
    ctx.shadowColor = '#FFD700';
    ctx.shadowBlur = 5;

    // Top-left corner
    ctx.beginPath();
    ctx.moveTo(cornerSize + 10, 12);
    ctx.lineTo(12, 12);
    ctx.lineTo(12, cornerSize + 10);
    ctx.stroke();

    // Top-right corner
    ctx.beginPath();
    ctx.moveTo(QR_SIZE - cornerSize - 10, 12);
    ctx.lineTo(QR_SIZE - 12, 12);
    ctx.lineTo(QR_SIZE - 12, cornerSize + 10);
    ctx.stroke();

    // Bottom-left corner
    ctx.beginPath();
    ctx.moveTo(cornerSize + 10, QR_SIZE - 12);
    ctx.lineTo(12, QR_SIZE - 12);
    ctx.lineTo(12, QR_SIZE - cornerSize - 10);
    ctx.stroke();

    // Bottom-right corner
    ctx.beginPath();
    ctx.moveTo(QR_SIZE - cornerSize - 10, QR_SIZE - 12);
    ctx.lineTo(QR_SIZE - 12, QR_SIZE - 12);
    ctx.lineTo(QR_SIZE - 12, QR_SIZE - cornerSize - 10);
    ctx.stroke();

    ctx.shadowBlur = 0;

    // Try to load and draw the king logo in center
    try {
        const logoPath = path.resolve('king_logo.png');
        if (fs.existsSync(logoPath)) {
            const logoImg = new Image();
            await new Promise((resolve, reject) => {
                logoImg.onload = resolve;
                logoImg.onerror = resolve; // Don't fail if logo can't load
                logoImg.src = fs.readFileSync(logoPath);
            });
            
            // Draw logo in center (small, so QR still scannable)
            const logoSize = 60;
            const logoX = (QR_SIZE - logoSize) / 2;
            const logoY = (QR_SIZE - logoSize) / 2;
            
            // Add white rounded background behind logo
            ctx.fillStyle = '#0D0D1A';
            ctx.beginPath();
            ctx.roundRect(logoX - 5, logoY - 5, logoSize + 10, logoSize + 10, 8);
            ctx.fill();
            ctx.strokeStyle = '#FFD700';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.roundRect(logoX - 5, logoY - 5, logoSize + 10, logoSize + 10, 8);
            ctx.stroke();
            
            ctx.drawImage(logoImg, logoX, logoY, logoSize, logoSize);
        }
    } catch (e) {
        // Logo not found, skip
    }

    return canvas.toBuffer('image/png');
}

/**
 * Generate UPI QR data string
 */
export function createUpiQrData(upiId, name, amount) {
    let uri = `upi://pay?pa=${upiId}`;
    if (name) uri += `&pn=${encodeURIComponent(name)}`;
    if (amount && parseInt(amount) > 0) uri += `&am=${amount}`;
    uri += `&cu=INR`;
    return uri;
}

/**
 * Generate crypto QR data string
 */
export function createCryptoQrData(address, currency, amount) {
    switch (currency.toLowerCase()) {
        case 'btc':
            return amount ? `bitcoin:${address}?amount=${amount}` : `bitcoin:${address}`;
        case 'ltc':
            return amount ? `litecoin:${address}?amount=${amount}` : `litecoin:${address}`;
        case 'usdt':
            return address; // USDT addresses are plain text
        default:
            return address;
    }
}
