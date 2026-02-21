# Benchmark

A personal tracking app for keeping yourself accountable to your own goals. Set targets by category, log what you actually do, and see how you're stacking up over time.

Works for any resource you want to track rhythmically — currently supports time (weekly hours per activity) and money (spending categories via OFX import).

## Stack

- **Frontend:** Preact + htm, no build step. Works offline as a PWA via service worker.
- **Backend:** Node/Express + SQLite (better-sqlite3), runs in Docker.
- **Sync:** Local-first. IndexedDB on device, syncs over home network to the Docker server.

## Running It

**Requirements:** Docker, mkcert (for local HTTPS)

1. Generate local certs: `mkcert -key-file key.pem -cert-file cert.pem <your-local-ip>`
2. Place `cert.pem` and `key.pem` in the project root (gitignored)
3. `docker compose up`
4. Open `https://<your-local-ip>:3000` on any device on your network

## Origin

Started as a prototype in [Brainstorming Lab](https://github.com/johanbolofsson/Brainstorming-Lab) — the original prototype lives there.
