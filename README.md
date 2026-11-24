# wardogscodebreaker

A web app that helps groups of friends get the Code Breaker achievement in WARDOGS.

A small web app that lets a group brute-force a WARDOGS Drill Tower code together without anyone repeating a guess. Everyone in the group sees the same next code live. The code changes only when someone clicks **Code wrong**.

- Group invite codes are 8 random characters, for example `GMSK-B4KD`
- Code length is 3–5 digits. Known digits can be entered in their positions.
- Warns when fewer than 3 digits are unknown, because Code Breaker needs at least 3 guessed digits
- Tries codes with no repeated digits first, then the rest. Each list is shuffled in a random order unique to the group, shared by everyone viewing it, and reshuffled on Start fresh attempt.
- Shows attempts made, combinations left, and a shared attempt log
- Has **Undo last** for misclicks and **Start fresh attempt** for a new match
- No dependencies: Node 18+ only

## Run locally

1. Install Node.js 18 or newer from nodejs.org.
2. Open a terminal in this folder and run `npm start`.
3. Open http://localhost:3000.

## Deploy (Render, free tier)

1. Push this folder to a GitHub repository.
2. In Render, choose **New → Web Service** and pick the repo.
3. Runtime: **Docker**, which uses the included Dockerfile. Alternatively, choose **Node** with start command `npm start`.
4. Add environment variable `TRUST_PROXY=1`. This makes rate limiting see real visitor IPs behind Render's proxy.
5. Deploy, then share `https://<your-app>.onrender.com`.

Free Render instances sleep when idle, and their disk is wiped on redeploy. Groups survive a restart only if you attach a persistent disk mounted at `/app/data`. Without one, a sleep or redeploy deletes active groups.

Any host that runs Docker or Node and allows long-lived HTTP connections will work, such as Fly.io, Railway, or a VPS behind nginx/Caddy. Always serve it over HTTPS.

## Settings (environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | 3000 | Port to listen on |
| `DATA_DIR` | `./data` | Where `groups.json` is saved |
| `TRUST_PROXY` | off | Set to `1` behind a reverse proxy |
| `GROUP_TTL_HOURS` | 48 | Idle groups are deleted after this long |
| `MAX_GROUPS` | 5000 | Cap on groups held at once |

## Run on a single instance only

State lives in memory and is pushed live to browsers from that one process. If you run two or more instances, each one will show a different next code. Scaling past one instance would need a shared store such as Redis.

## Security notes

- Anyone who has the invite code can change the group's state. Share it only with your squad.
- Invite codes have about 40 bits of randomness. Repeated wrong invite codes from one IP are rate-limited.
- There are no accounts and no personal data. Display names are stored only in the browser and in the attempt log.
- A strict Content-Security-Policy and `no-referrer` are set, so invite links don't leak through the Referer header.

## Test

`npm test` checks the combination engine.
