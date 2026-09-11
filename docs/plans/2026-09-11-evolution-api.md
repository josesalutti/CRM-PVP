# Evolution API (WhatsApp via QR code) — implementation plan

Status: in progress · Branch: `feature/evolution-api`

## Goal

Each account chooses how its WhatsApp number is connected:

- `meta` — the existing official Cloud API integration (unchanged).
- `evolution` — an unofficial connection through a self-hosted
  [Evolution API v2](https://github.com/EvolutionAPI/evolution-api)
  server, paired by scanning a QR code.

Inbox, flows, automations, AI and the public API keep working without
knowing which provider sits underneath.

## Decisions

| Topic | Decision |
|---|---|
| Coexistence | Per-account `whatsapp_config.provider` (`meta` \| `evolution`). |
| Hosting | Runs on the developer's machine for now. Evolution API runs in Docker Desktop (`docker-compose.evolution.yml`); it reaches the Next dev server at `host.docker.internal:3000`. Nothing assumes Vercel. |
| Evolution auth | wacrm calls Evolution with the global `EVOLUTION_API_KEY` (server-only). Per-instance tokens are not stored. |
| Webhook auth | Evolution does not sign requests. Each instance is created with a random secret sent back in the `x-wacrm-webhook-secret` header; stored encrypted, compared in constant time. |
| Groups | `@g.us` chats are ignored. |
| Interactive messages | Not reliable on Baileys: rendered as a numbered text menu; a numeric reply is mapped back to the option id so flows keep routing. |
| Templates | Meta-only; hidden for `evolution` accounts. |
| Audio transcription | Uses the account's stored OpenAI key (chat key when provider is OpenAI, else the embeddings key). No key → no transcription. Stored in `messages.transcription`, **not shown in the inbox**; used as the text for flows, keywords and AI. Applies to Meta accounts too. |
| Broadcasts | Free-form text/media (no template) drained from a queue by a secret-protected cron endpoint, with random spacing and a per-number daily cap. |

## Phases

1. **Foundation** — migration 041, `src/lib/whatsapp/evolution-api.ts`
   client + tests, `docker-compose.evolution.yml`, env vars, docs.
2. **Connect by QR** — `/api/whatsapp/evolution/{connect,qr,state,disconnect}`
   routes; provider selector + QR panel in Settings.
3. **Inbound** — extract the Meta webhook's message pipeline into a
   shared module; `/api/whatsapp/evolution/webhook` parses
   `messages.upsert` / `messages.update` / `connection.update`; media
   (base64) mirrored to `chat-media`.
4. **Outbound** — provider-aware transport used by
   `send-message.ts`, `automations/meta-send.ts`, `flows/meta-send.ts`;
   interactive → numbered menu fallback.
5. **Audio** — voice-note send (`sendWhatsAppAudio`); transcription
   pipeline feeding flows/automations/AI.
6. **Broadcasts** — queue + cron drain for `evolution` accounts.
