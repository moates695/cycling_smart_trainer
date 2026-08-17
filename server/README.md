# WATTS API

Accounts and sync for the WATTS PWA. FastAPI + Postgres, self-hosted, sitting behind the same
nginx that serves the static site.

It exists to fix two concrete defects, not as infrastructure for its own sake:

- ride history was capped at seven locally, and the eighth ride destroyed the first, FIT file
  included (`src/models/models.js`, now lifted);
- custom workouts were stranded on one browser profile, one storage clear away from gone;
- so was the rider profile, so a second device silently rode every %FTP target against a default
  200 W.

## Design in one paragraph

IndexedDB stays the source of truth for the running app; the server is a replica that converges in
the background. No UI path blocks on a network call, so the app works signed out, offline, and
mid-interval on bad wifi. Records carry client-generated UUIDs, so an offline creation keeps its
identity when it eventually syncs. Deletes are tombstones — without them a workout deleted on the
laptop is resurrected by the phone on its next push.

Three things sync, all off one integer cursor drawn from a single sequence: custom **workouts**,
**activity** summaries (with the FIT blob going to Spaces separately), and the rider **profile** —
FTP and weight — as one row per user rather than one per field.

## Running it locally

```bash
cp .env.example .env
uv sync
uv run alembic upgrade head
uv run uvicorn app.main:app --reload --port 8010
```

There are two environments and no others: this local dev database, and prod on the droplet.
Locally that is a Postgres installed on the machine rather than a container — on this developer's
WSL setup, the PostgreSQL 17 on the Windows host. It needs a `watts` role and one database,
`watts_dev`, owned by it:

```sql
create role watts login password 'watts' createdb;
create database watts_dev owner watts;
```

`createdb` only because the test suite builds a scratch database per run and drops it again;
`watts_dev` is the one that outlives a command. `host.docker.internal` rather than an IP address,
because the WSL NAT gateway is renumbered when the VM restarts.

Then `npm start` in the repo root. Parcel's `.proxyrc` forwards `/api` to port 8010, so the client
calls a same-origin `/api/...` in both environments and needs no environment switch. Port 8010
rather than 8000 because 8000 is taken both on this machine and on the droplet (`api-prod` owns it).

## Tests

```bash
uv run pytest                 # scratch database on the same server, dropped after
uv run pytest tests/test_isolation.py -v
```

`tests/test_isolation.py` is the one to keep green. It is the standing proof that every query scopes
on the user id taken from the session cookie — never from a request body or path parameter — checked
per endpoint, including the case where one user knows another's record ids.

The suite drops and recreates the schema on each run, so a model change never leaves the test
database quietly out of step. `tests/test_migrations.py` separately proves the Alembic migration
produces the same tables, columns and primary keys the models declare, so `alembic upgrade head` on
the droplet cannot drift from what the code expects.

## Layout

| Path | What lives there |
|---|---|
| `app/config.py` | Settings, read from `.env` with the `WATTS_` prefix |
| `app/models.py` | SQLAlchemy tables |
| `app/security.py` | argon2id hashing, session tokens, reset code generation and keyed hashing |
| `app/email.py` | Outbound SMTP. Logs instead of sending when unconfigured |
| `app/deps.py` | `get_current_user` — the only place a user identity is established |
| `app/sync_engine.py` | Merge rules: last-write-wins, tombstone precedence, cursor paging |
| `app/storage.py` | DigitalOcean Spaces presigning |
| `app/routers/` | The endpoints |
| `migrations/` | Alembic |

## Security notes

- **Passwords are hashed, never encrypted.** Encryption is reversible and implies a key that can
  recover plaintext; anyone holding both the database and that key would have every user's password,
  and because people reuse passwords, their email with it. argon2id, per-password random salt,
  parameters recorded in the hash string so `check_needs_rehash()` can upgrade them later.
- The session cookie is opaque, `HttpOnly; Secure; SameSite=Lax`. Only its sha256 is stored, so a
  database leak yields no usable live sessions.
- Login returns identical text and takes similar time for an unknown email and a wrong password, so
  the endpoint does not confirm which addresses are registered.
- The primary key on `workouts` and `activities` is `(user_id, id)`, not `id`. Ids arrive from
  clients, so a global key would let one user's push collide with another user's row — a constraint
  violation that both breaks the request and confirms the id exists.
- Rate limits on login, register and password change. With no 2FA these are the only thing between a
  weak password and credential stuffing.
- **Reset codes are stored as HMAC-SHA256 keyed with `WATTS_SECRET_KEY`, never as a plain digest.**
  Six digits is a space of one million, so a bare sha256 column would be reversible from a read-only
  database leak in milliseconds — turning it into full account takeover despite argon2 on the
  passwords. The user id goes into the HMAC message too, so a row can only ever satisfy its own
  account. The API refuses to start in production without the key.
- `POST /api/auth/password/reset` always answers 204. Answering differently for a registered address
  would make it a membership oracle for the whole user table, which here links an email to a
  person's training data.
- The rider's intervals.icu key stays client-side in `localStorage` and is deliberately **not**
  synced. Putting a third-party credential in the account would make a WATTS breach a breach of
  their intervals.icu account too.

## Forgotten passwords

`POST /api/auth/password/reset` emails a six digit code; `POST /api/auth/password/reset/confirm`
trades the code and a new password for a session on that device.

A code rather than a link, because the app is a PWA: a link opens whatever browser handles mail — on
iOS always Safari, never the installed home screen app — so the session a link flow produces lands
in the wrong browser. A code keeps the whole thing in the tab that started it.

What bounds abuse, in order of how much work each one does:

| Control | Where | Why |
|---|---|---|
| 5 attempts per code | `password_resets.attempts` | The real defence. Six digits is only ~20 bits, so guessing is capped per code, not per IP |
| 15 minute expiry | `reset_code_ttl_minutes` | A code left in an inbox stops being a standing liability |
| One live code per account | `_spend_codes` | A replacement retires its predecessor, so two codes never widen the guessing surface |
| 3 requests per account per hour | `reset_max_per_hour`, counted in the database | IP limits do not stop a botnet filling one rider's inbox |
| 3/min, 10/hour per IP | `rate_limit.py` | Ordinary flood control |

The rows are kept after they are spent rather than deleted, because the hourly cap counts rows —
deleting spent ones would erase the history the throttle runs on. They go with the account through
the FK cascade.

Both a reset and a deliberate password change kill every session and email the rider that it
happened. That notice is the only signal they get if it was not them.

Mail goes out over plain SMTP (`app/email.py`), currently a dedicated Gmail account with an App
Password. Leave `WATTS_SMTP_HOST` blank and messages are logged instead of sent, code included,
which is how the test suite and any machine without credentials run — production logs the drop
without the body, so a live code never reaches the application log.

Note that DigitalOcean blocks outbound SMTP on some accounts. Before relying on this in production:

```bash
nc -zv smtp.gmail.com 587      # from the droplet
```

## Deploying

```bash
../deploy/setup-api.sh        # once, on the droplet
../deploy/deploy-api.sh       # every release
```

`deploy-api.sh` runs `alembic upgrade head` before the new code goes live, so the schema is never
behind the app. That ordering is safe because every migration so far is additive.

The API is never published to the host — nginx reaches it over `backend-prod_api-network`. Its
Postgres is bound to loopback only, so `pg_dump` from the droplet works but nothing off it can
connect.
