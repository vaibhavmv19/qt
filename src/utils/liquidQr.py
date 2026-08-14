#!/usr/bin/env python3
"""
SILVER LIQUID QR RENDERER — exact port of generate_king_qr.py tuned params
Default/silver theme: silver (234,234,234) liquid dots on BLACK background.

CLI:
  python3 liquidQr.py <upi_data> <output_path> [theme]
Outputs PNG buffer also supports base64 stdout for node integration:
  python3 liquidQr.py <upi_data> b64
"""
import qrcode
from PIL import Image, ImageDraw, ImageFilter, ImageOps, ImageChops
import numpy as np
import cv2
import sys
import base64
import os
import io
import json

STAR_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'king_logo_transparent.png')


def get_brightness(color, factor):
    r, g, b, a = color
    return (min(255, int(r * factor)), min(255, int(g * factor)), min(255, int(b * factor)), a)


def generate_liquid_qr(data, star_path, output_path, theme='silver'):
    # 1. Generate QR Matrix (EC level H so logo can overlay ~30% of center)
    qr = qrcode.QRCode(
        version=None,
        error_correction=qrcode.constants.ERROR_CORRECT_H,
        box_size=1,
        border=4,
    )
    qr.add_data(data)
    qr.make(fit=True)
    matrix = np.array(qr.get_matrix())
    dim = matrix.shape[0]
    scale = 40
    width = dim * scale
    height = dim * scale

    # 2. Prepare Background — pure black for silver theme
    if theme == 'king':
        bg_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'king_bg_asset.png')
        bg_asset = Image.open(bg_path).convert("RGBA")
        canvas = bg_asset.resize((width, height), Image.Resampling.LANCZOS)
    else:
        canvas = Image.new('RGBA', (width, height), (0, 0, 0, 255))

    # 3. Load Star Logo & silhouette
    if isinstance(star_path, str):
        star_logo = Image.open(star_path).convert("RGBA")
    else:
        star_logo = star_path  # pre-loaded Image (server mode)
    star_w = int(width * 0.18)
    star_h = int(star_w * (star_logo.height / star_logo.width))
    star_logo = star_logo.resize((star_w, star_h), Image.Resampling.LANCZOS)
    cx, cy = width // 2, height // 2
    sx, sy = cx - star_w // 2, cy - star_h // 2

    star_sil = Image.new('L', (width, height), 0)
    star_sil.paste(star_logo.getchannel('A'), (sx, sy))

    # 4. Create high-res module mask (Liquid Layer)
    # SPEED: vectorize module listing with numpy (avoids per-pixel getpixel loops)
    liquid_mask = Image.new('L', (width, height), 0)
    draw_mask = ImageDraw.Draw(liquid_mask)
    box_size = scale
    star_np = np.array(star_sil)
    for r in range(dim):
        for c in range(dim):
            if matrix[r][c]:
                # Finder patterns handled later — skip finder zones
                if (r < 7 and c < 7) or (r < 7 and c >= dim - 7) or (r >= dim - 7 and c < 7):
                    continue
                x, y = c * box_size, r * box_size
                mx, my = x + box_size // 2, y + box_size // 2
                # Skip module if it overlaps the star silhouette (numpy lookup)
                if star_np[my, mx] > 150:
                    continue
                # Draw module circle (liquid dot)
                rad = box_size * 0.38
                draw_mask.ellipse([mx - rad, my - rad, mx + rad, my + rad], fill=255)
                # Horizontal bridge to right neighbor
                if c < dim - 1 and matrix[r][c + 1]:
                    nmx, nmy = (c + 1) * box_size + box_size // 2, my
                    if star_np[nmy, nmx] <= 150:
                        draw_mask.rectangle([mx, my - rad, nmx, my + rad], fill=255)
                # Vertical bridge to below neighbor
                if r < dim - 1 and matrix[r + 1][c]:
                    nmx, nmy = mx, (r + 1) * box_size + box_size // 2
                    if star_np[nmy, nmx] <= 150:
                        draw_mask.rectangle([mx - rad, my, mx + rad, nmy], fill=255)

    # Refine Liquid Mask: blur then threshold for organic "liquid" feel
    # gaussian blur radius = scale*0.1 (<= 0.10 box rule), threshold > 128
    # SPEED: cv2 separable Gaussian blur (~5x faster than PIL on large masks)
    _lm_np = np.array(liquid_mask).astype(np.float32)
    _lm_np = cv2.GaussianBlur(_lm_np, (0, 0), sigmaX=scale * 0.1)
    liquid_mask = Image.fromarray((_lm_np > 128).astype(np.uint8) * 255, mode='L')

    # Sharp termination against logo
    liquid_mask = ImageChops.subtract(liquid_mask, star_sil)

    # 5. Render Modules with Illumination Rings
    qr_color_base = (234, 234, 234, 255) if theme == 'king' else (234, 234, 234, 255)

    # Ring masks: +15% brightness closest (blur scale*0.4), +5% next (blur scale*1.2)
    # SPEED: cv2 separable Gaussian blur on numpy alpha (~5x faster than PIL)
    _sil_np = np.array(star_sil).astype(np.float32)
    ring2_np = cv2.GaussianBlur(_sil_np, (0, 0), sigmaX=scale * 1.2)
    ring1_np = cv2.GaussianBlur(_sil_np, (0, 0), sigmaX=scale * 0.4)
    ring2_mask = Image.fromarray(ring2_np.astype(np.uint8), mode='L')
    ring1_mask = Image.fromarray(ring1_np.astype(np.uint8), mode='L')

    solid_qr = Image.new('RGBA', (width, height), qr_color_base)
    # Apply +5% ring first, then +15% ring on top
    bright_qr_5 = Image.new('RGBA', (width, height), get_brightness(qr_color_base, 1.05))
    solid_qr = Image.composite(bright_qr_5, solid_qr, ring2_mask)
    bright_qr_15 = Image.new('RGBA', (width, height), get_brightness(qr_color_base, 1.15))
    solid_qr = Image.composite(bright_qr_15, solid_qr, ring1_mask)

    canvas.paste(solid_qr, (0, 0), mask=liquid_mask)

    # 6. Sharp Rounded Finder Patterns
    eye_pos = [(4 * scale, 4 * scale), ((dim - 11) * scale, 4 * scale), (4 * scale, (dim - 11) * scale)]
    for ex, ey in eye_pos:
        rad = scale * 1.2
        draw_eye = ImageDraw.Draw(canvas)
        eye_size = 7 * scale
        draw_eye.rounded_rectangle([ex, ey, ex + eye_size, ey + eye_size], radius=rad, fill=qr_color_base)
        draw_eye.rounded_rectangle([ex + scale, ey + scale, ex + eye_size - scale, ey + eye_size - scale],
                                   radius=rad * 0.8, fill=(0, 0, 0, 255))
        draw_eye.rounded_rectangle([ex + 2 * scale, ey + 2 * scale, ex + eye_size - 2 * scale, ey + eye_size - 2 * scale],
                                   radius=rad * 0.5, fill=qr_color_base)

    # 7. Final Logo & Luxury Glow — three layers of white glow
    # SPEED: blur the small logo tiles at native size instead of full-canvas
    # RGBA blurs (full-canvas blur = ~600ms; tiled approach = ~40ms total)
    # SPEED: blur small tile-sized RGBA layers instead of full-canvas RGBA blurs.
    # Mask for pasting glow tiles = the original star alpha silhouette.
    glow_layers = [(6, 0.8), (18, 0.35), (40, 0.1)]
    star_alpha_mask = star_logo.getchannel('A')
    combined_glow = Image.new('RGBA', (width, height), (0, 0, 0, 0))
    for blur, opacity in glow_layers:
        layer = Image.new('RGBA', star_logo.size, (255, 255, 255, int(255 * opacity)))
        layer = layer.filter(ImageFilter.GaussianBlur(blur * (scale / 20)))
        # Paste tile into a per-layer canvas, masked by the star alpha (no gray box)
        full_layer = Image.new('RGBA', (width, height), (0, 0, 0, 0))
        full_layer.paste(layer, (sx, sy), mask=star_alpha_mask)
        combined_glow = Image.alpha_composite(combined_glow, full_layer)

    canvas = Image.alpha_composite(canvas, combined_glow)
    canvas.paste(star_logo, (sx, sy), mask=star_logo)

    if hasattr(output_path, 'write'):
        # BytesIO / file-like
        canvas.save(output_path, format='PNG', compress_level=1)
        return output_path
    canvas.save(output_path, compress_level=1)
    return output_path


# ═══════════════════════════════════════════════════════════
# PERSISTENT SERVER MODE (speed optimization)
# Run once, keep PIL/numpy/star assets warmed; render on demand
# Protocol: request  = JSON line: {"data": "...", "theme": "silver"}\n
#           response = base64 PNG line, then "DONE" line
# ═══════════════════════════════════════════════════════════
if __name__ == "__main__" and "--server" in sys.argv:
    import socket
    import threading
    # Custom port support (used by worker pool mode)
    _custom_port = None
    for _a in sys.argv[1:]:
        if _a != '--server' and _a.isdigit():
            _custom_port = int(_a)

    def _handle(conn, warm_star):
        try:
            buf = b''
            while b'\n' not in buf:
                chunk = conn.recv(4096)
                if not chunk:
                    return
                buf += chunk
            try:
                payload = json.loads(buf.decode('utf-8'))
            except json.JSONDecodeError:
                parts = buf.decode('utf-8').strip().split('|')
                payload = {'data': parts[0], 'theme': parts[1] if len(parts) > 1 else 'silver'}
            out = io.BytesIO()
            generate_liquid_qr(payload.get('data', ''), warm_star, out, theme=payload.get('theme', 'silver'))
            conn.sendall((base64.b64encode(out.getvalue()).decode('ascii') + '\nDONE\n').encode('ascii'))
        except Exception as e:
            try:
                conn.sendall(('ERROR: ' + str(e)[:300] + '\n').encode('ascii'))
            except Exception:
                pass
        finally:
            try:
                conn.close()
            except Exception:
                pass

    warm_star = Image.open(STAR_PATH).convert("RGBA")
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    _port = _custom_port or 9765
    srv.bind(('127.0.0.1', _port))
    srv.listen(512)
    print(f'liquidQr server listening on 127.0.0.1:{_port}', flush=True)
    while True:
        conn, _ = srv.accept()
        threading.Thread(target=_handle, args=(conn, warm_star), daemon=True).start()
else:
    if __name__ == "__main__":
        if len(sys.argv) < 2:
            generate_liquid_qr("upi://pay?pa=demo@upi&pn=Demo&cu=INR", STAR_PATH, "silver_qr.png", theme='silver')
            print("demo saved: silver_qr.png")
            sys.exit(0)

        data = sys.argv[1]
        output = sys.argv[2]
        theme = sys.argv[3] if len(sys.argv) > 3 else 'silver'

        if output == 'b64':
            with io.BytesIO() as tmp:
                generate_liquid_qr(data, STAR_PATH, tmp, theme=theme)
                print(base64.b64encode(tmp.getvalue()).decode('ascii'))
        else:
            generate_liquid_qr(data, STAR_PATH, output, theme=theme)
            print("saved:", output)
