-- ============================================================
-- whatsapp_config: per-account provider (Meta Cloud API | Evolution API)
--
-- Why this exists:
--   Accounts that cannot use the official Cloud API (no verified Meta
--   business) connect their number through a self-hosted Evolution API
--   server by scanning a QR code. The two providers need different
--   credentials, so:
--
--     * `provider` selects the transport. Existing rows are 'meta'.
--     * `phone_number_id` / `access_token` become nullable — an
--       Evolution row has neither. The CHECK below still requires them
--       for 'meta' rows, so the Meta code paths keep their invariant.
--       UNIQUE(phone_number_id) (migration 013) is unaffected: Postgres
--       treats NULLs as distinct.
--     * `evolution_instance_name` identifies the Evolution instance and
--       is how the Evolution webhook routes an event to its account.
--     * `evolution_webhook_secret` (AES-256-GCM, same `encrypt()` as
--       access_token) authenticates Evolution's webhook calls, which
--       carry no signature of their own.
--     * `display_phone_number` is filled once the QR pairing completes.
--     * status gains 'connecting' (QR shown, not yet scanned).
--
--   messages.transcription holds the speech-to-text of an inbound voice
--   note. It is internal: flows, keyword triggers and the AI read it;
--   the inbox does not display it.
-- ============================================================

ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'meta',
  ADD COLUMN IF NOT EXISTS evolution_instance_name TEXT,
  ADD COLUMN IF NOT EXISTS evolution_webhook_secret TEXT,
  ADD COLUMN IF NOT EXISTS display_phone_number TEXT;

ALTER TABLE whatsapp_config ALTER COLUMN phone_number_id DROP NOT NULL;
ALTER TABLE whatsapp_config ALTER COLUMN access_token DROP NOT NULL;

ALTER TABLE whatsapp_config DROP CONSTRAINT IF EXISTS whatsapp_config_provider_check;
ALTER TABLE whatsapp_config
  ADD CONSTRAINT whatsapp_config_provider_check
  CHECK (provider IN ('meta', 'evolution'));

-- Each provider's required credentials.
ALTER TABLE whatsapp_config DROP CONSTRAINT IF EXISTS whatsapp_config_provider_fields_check;
ALTER TABLE whatsapp_config
  ADD CONSTRAINT whatsapp_config_provider_fields_check
  CHECK (
    (provider = 'meta'
      AND phone_number_id IS NOT NULL
      AND access_token IS NOT NULL)
    OR
    (provider = 'evolution'
      AND evolution_instance_name IS NOT NULL
      AND evolution_webhook_secret IS NOT NULL)
  );

-- The inline CHECK from migration 001 is auto-named
-- `whatsapp_config_status_check`.
ALTER TABLE whatsapp_config DROP CONSTRAINT IF EXISTS whatsapp_config_status_check;
ALTER TABLE whatsapp_config
  ADD CONSTRAINT whatsapp_config_status_check
  CHECK (status IN ('connected', 'disconnected', 'connecting'));

CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_config_evolution_instance_name_key
  ON whatsapp_config (evolution_instance_name)
  WHERE evolution_instance_name IS NOT NULL;

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS transcription TEXT;
