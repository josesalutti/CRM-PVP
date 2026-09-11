# Evolution API (WhatsApp by QR code)

wacrm can connect an account's WhatsApp number in two ways:

| Provider | How it connects | Needs |
|---|---|---|
| **Meta Cloud API** (official) | Access token + phone number ID | A Meta app and, for production, a verified business |
| **Evolution API** (unofficial) | Scan a QR code, like WhatsApp Web | An Evolution API server you run |

> **Risk.** Evolution API drives WhatsApp through the WhatsApp Web
> protocol, which WhatsApp's terms do not allow for automation. Numbers
> that message strangers or send in bulk can be banned. Prefer the
> official API when you can; use a number you can afford to lose while
> testing.

## 1. Install Docker Desktop

Download it from <https://www.docker.com/products/docker-desktop/>,
install, and start it. Check in a terminal:

```bash
docker --version
docker compose version
```

## 2. Configure and start Evolution API

From the wacrm folder:

```bash
cp .env.evolution.example .env.evolution     # PowerShell: copy .env.evolution.example .env.evolution
```

Edit `.env.evolution` and replace both `change-me` values with long
random strings:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Start the stack (Evolution API + its own Postgres + Redis):

```bash
docker compose -f docker-compose.evolution.yml up -d
```

It listens on `http://localhost:8080`, bound to this machine only.
Opening that URL should return a JSON welcome message.

## 3. Point wacrm at it

Add to `.env.local` (values from step 2):

```bash
EVOLUTION_API_URL=http://localhost:8080
EVOLUTION_API_KEY=<same as AUTHENTICATION_API_KEY in .env.evolution>
EVOLUTION_WEBHOOK_BASE_URL=http://host.docker.internal:3000
```

`EVOLUTION_WEBHOOK_BASE_URL` is how the **container** reaches wacrm.
Inside Docker, `localhost` means the container itself, so use
`host.docker.internal` while wacrm runs with `npm run dev` on the same
machine. If wacrm later moves to a public domain, set it to that domain.

Apply the database migration `supabase/migrations/041_whatsapp_provider_evolution.sql`
(Supabase dashboard → SQL editor, or `supabase db push`), then restart
`npm run dev`.

## 4. Connect a number

Settings → WhatsApp → choose **QR code (Evolution)** → **Connect** →
scan the QR with WhatsApp on the phone (Settings → Linked devices →
Link a device).

## Security notes

- `EVOLUTION_API_KEY` grants full control of every connected number.
  It lives only in server env files — never in client code or Git.
- Each instance authenticates its webhook calls with its own random
  secret header, stored encrypted with `ENCRYPTION_KEY`. Requests
  without it are rejected.
- Keep port 8080 bound to `127.0.0.1` (as in the compose file) unless a
  reverse proxy with TLS sits in front of it.

## Useful commands

```bash
docker compose -f docker-compose.evolution.yml logs -f evolution-api   # live logs
docker compose -f docker-compose.evolution.yml down                    # stop (sessions kept)
docker compose -f docker-compose.evolution.yml down -v                 # stop AND wipe sessions
```
