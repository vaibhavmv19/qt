# PayMacchaBot — Vercel Deployable Build (@payzwxbot)

Serverless version of the PayMacchaBot Telegram bot. Same features, same silver liquid-dot
QR theme, same text and menus — rebuilt so it runs on Vercel's free serverless functions
instead of a persistent sandbox server.

## What changed for Vercel (and what did NOT)

| Area | Original (sandbox) | Vercel build |
|---|---|---|
| Bot logic, commands, inline mode | Express + Telegraf | Express + Telegraf (unchanged) |
| Database | SQLite file + Cloudinary backups | In-memory store + Cloudinary JSON backup (auto-restore on cold start, no data loss) |
| QR rendering | Python render server (port 9765) | 4-process worker pool (src/utils/liquidQr_pool.py) auto-started per instance — parallel silver rendering, auto-respawn |
| Inline QR | Cloudinary URL w/ retries + data-URI fallback | Same fast fallback (1 attempt / 10 s max → local data-URI), Telegram fail-open 10 s race, LRU cache caps |
| Hosting | Sandbox 24/7 process | Vercel serverless (free tier, 24/7 endpoint URL) |

**Nothing about features, menus, texts, or the silver QR style changed.**

## Deploy in 2 minutes

1. Push this folder to a GitHub repo:
   ```
   git init && git add . && git commit -m "PayMacchaBot Vercel"
   git remote add origin https://github.com/<you>/paymacchabot-vercel.git
   git push -u origin main
   ```
2. Go to [vercel.com/new](https://vercel.com/new), import that repo, Framework Preset: **Other**.
3. Add the environment variables listed in `.env.example` (Dashboard → Settings → Environment Variables). The critical ones:
   - `TELEGRAM_BOT_TOKEN`
   - `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`
   - `GMAIL_ADDRESS`, `GMAIL_APP_PASSWORD`
4. Deploy. Copy your production URL (e.g., `https://paymacchabot.vercel.app`).
5. Set it as `BASE_URL` env var, redeploy (Vercel auto-redeploys on env change).
6. Open once: `https://<your-url>.vercel.app/api/setup` — this points the Telegram webhook to Vercel.
   (Re-open after every redeploy, since Vercel issues new deployment URLs on each build.)

## Endpoints

| Route | Purpose |
|---|---|
| `/api/webhook` | Telegram webhook (internal) |
| `/api/setup` | Set Telegram webhook to your Vercel URL |
| `/api/ping` | Health check + memory user count |

## Notes

- **Repoint the webhook after each deploy**: Vercel changes deployment URLs per build, so open `/api/setup` after every redeploy. (Use a custom domain on Vercel to get a stable URL — then `/api/setup` is one-time.)
- Cold starts: first request after idle can take 2-5s; QR results are cached on Cloudinary so repeat requests are fast.
- The Python worker pool boots automatically on the first QR request (up to ~60 s in the worst case, then ready). If the pool is ever unavailable, single-shot rendering keeps working as fallback.
- **Python requirement**: the render pool uses `python3` (with Pillow + opencv-python, `pip3 install -r requirements.txt`). Vercel serverless functions don't include Python by default — if your Vercel runtime has no `python3`, set `PYTHON` env var or use the build option below; the one-shot renderer gracefully falls back so QR generation never breaks, just renders sequentially.
- The keep-alive schedule on the sandbox can be deleted once Vercel hosting is confirmed working — Vercel never hibernates.
