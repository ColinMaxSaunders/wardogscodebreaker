# wardogscodebreaker

A web app that helps groups of friends get the Code Breaker achievement in WARDOGS.

A small web app that lets a group brute-force a WARDOGS Drill Tower code together without anyone repeating a guess. Everyone in the group sees the same next code live, and the app's suggestion changes only when someone clicks **Code wrong**. The game's code is one code for the whole map. It changes whenever anyone in the match calls in any drill (a correct tower code or a FOB drill rig, from any faction), and on a new match.

- Group invite codes are 8 random characters, for example `GMSK-B4KD`
- Code length is 3–5 digits. Known digits can be entered in their positions.
- Warns when fewer than 3 digits are unknown, because Code Breaker needs at least 3 guessed digits
- Blocks guessing when 4 or 5 digits are unknown (10,000 or 100,000 codes) and tells the group how many more towers to capture
- Asks "Did the game accept this code?" before recording a correct code
- Gives each tower its own code. A keypad lockout hits everyone at that tower, so a squad spread across towers guesses in parallel, and no code is handed out twice. People at the same tower share one code.
- **Typed a different code by mistake?** logs the code that was actually entered, so it is never handed out again
- Known digits can be marked **Told** when another team shared them. They cut the codes to try but still count as guessed for the achievement
- Shows each tower's tries before the ~30-second lockout (3 wrong codes) and a countdown while it is locked
- Tries codes with no repeated digits first, then the rest. Each list is shuffled in a random order unique to the group, shared by everyone viewing it, and reshuffled on Start fresh attempt.
- Shows attempts made, combinations left, and a shared attempt log
- Has **Undo last** for misclicks and **Start fresh attempt** for whenever the game picks a new code (after anyone calls in any drill, tower code or FOB drill rig, even mid-match, or when a new match starts)
- Saves every code marked correct (no names) and shows pattern analysis at `/stats`, with a CSV download
- No dependencies: Node 18+ only

## Run locally

1. Install Node.js 18 or newer from nodejs.org.
2. Open a terminal in this folder and run `npm start`.
3. Open http://localhost:3000.

## Storage

The app keeps all live state in memory and saves it to one of two places:

- **Supabase** (recommended for any hosted deploy), used when `SUPABASE_URL` and `SUPABASE_SECRET_KEY` are both set. Groups and every recorded correct code survive restarts, redeploys and Render's free-tier sleep. Writes are queued and retried (1s, 2s, 4s, up to 30s), so a short Supabase outage loses nothing. If saved data can't be loaded at startup, the app refuses to start rather than run without it.
- **Local JSON files** in `DATA_DIR`, used when neither variable is set. Fine for running on your own PC. On Render's free tier these files are wiped on every restart.

### Supabase setup (one time)

1. Create a Supabase project just for this app. Don't reuse another app's project, because the secret key has full access to everything in its project.
2. In the project, open **SQL Editor → New query**, paste the contents of `supabase/schema.sql`, and click **Run**. It creates two tables and locks both so the public key can't read or write them.
3. Go to **Project Settings → API Keys**, then **Secret keys**. Create a key named `render-codebreaker` and copy it (it starts with `sb_secret_`).
4. In Render, open the service and go to **Environment**. Add `SUPABASE_URL` (`https://<project-ref>.supabase.co`) and `SUPABASE_SECRET_KEY` (the key you just copied), then save. Render redeploys automatically.
5. Check the Render log for `Storage: supabase. Loaded …`.

**Never put the secret key in front-end code, a commit, or a chat.** If it leaks, delete it in Supabase and create a new one. The app reads it only from the environment.

## Deploy (Render, free tier)

1. Push this folder to a GitHub repository.
2. In Render, choose **New → Web Service** and pick the repo.
3. Runtime: **Docker**, which uses the included Dockerfile. Alternatively, choose **Node** with start command `npm start`.
4. Add environment variable `TRUST_PROXY=1`. This makes rate limiting see real visitor IPs behind Render's proxy.
5. Deploy, then share `https://<your-app>.onrender.com`.

Free Render instances sleep when idle, and their disk is wiped on restart. Set up Supabase (above) so groups and recorded codes are kept.

Any host that runs Docker or Node and allows long-lived HTTP connections will work, such as Fly.io, Railway, or a VPS behind nginx/Caddy. Always serve it over HTTPS.

## Settings (environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | 3000 | Port to listen on |
| `SUPABASE_URL` | none | Supabase project URL. Set it together with `SUPABASE_SECRET_KEY` |
| `SUPABASE_SECRET_KEY` | none | Supabase secret key (`sb_secret_…`), server only |
| `DATA_DIR` | `./data` | Where the JSON files are saved when Supabase isn't configured |
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

`npm test` checks the combination engine and the stats math. `npm run test:store` checks Supabase persistence (writes, undo, retries during an outage, reload after restart, paging, shutdown flush) against a local mock of Supabase's REST API. It takes about a minute.
