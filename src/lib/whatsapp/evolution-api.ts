/**
 * Evolution API v2 helpers (unofficial WhatsApp connection via QR code).
 *
 * Mirrors `meta-api.ts`: every function takes a single options object so
 * swapped arguments surface as TypeScript errors.
 *
 * All calls authenticate with the server-wide `EVOLUTION_API_KEY` (sent
 * as the `apikey` header), which Evolution accepts for every instance —
 * so wacrm never needs to store per-instance tokens. The key and URL are
 * read at call time rather than module load so a missing env var fails
 * the request that needs it with a clear message, not the whole build.
 *
 * Server-only: never import this from client components.
 */

/** Header Evolution echoes back on every webhook call for an instance. */
export const EVOLUTION_WEBHOOK_SECRET_HEADER = 'x-wacrm-webhook-secret'

/** Events wacrm subscribes each instance to. */
export const EVOLUTION_WEBHOOK_EVENTS = [
  'MESSAGES_UPSERT',
  'MESSAGES_UPDATE',
  'CONNECTION_UPDATE',
  'QRCODE_UPDATED',
] as const

export class EvolutionApiError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'EvolutionApiError'
    this.status = status
  }
}

interface EvolutionEnv {
  baseUrl: string
  apiKey: string
}

function evolutionEnv(): EvolutionEnv {
  const baseUrl = process.env.EVOLUTION_API_URL?.trim().replace(/\/+$/, '')
  const apiKey = process.env.EVOLUTION_API_KEY?.trim()
  if (!baseUrl || !apiKey) {
    throw new EvolutionApiError(
      'Evolution API is not configured: set EVOLUTION_API_URL and EVOLUTION_API_KEY.',
      500,
    )
  }
  return { baseUrl, apiKey }
}

/**
 * Evolution error bodies vary by version: `{ message }`,
 * `{ response: { message: string | string[] } }` or
 * `{ error, response: {...} }`. Flatten whichever is present.
 */
async function throwEvolutionError(response: Response): Promise<never> {
  let message = `Evolution API error: ${response.status}`
  try {
    const data = (await response.json()) as {
      message?: unknown
      error?: unknown
      response?: { message?: unknown }
    }
    const raw = data.response?.message ?? data.message ?? data.error
    const text = Array.isArray(raw)
      ? raw.map((m) => (typeof m === 'string' ? m : JSON.stringify(m))).join('; ')
      : typeof raw === 'string'
        ? raw
        : null
    if (text) message = text
  } catch {
    // body wasn't JSON — keep the status-based message
  }
  throw new EvolutionApiError(message, response.status)
}

async function evolutionRequest<T>(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T> {
  const { baseUrl, apiKey } = evolutionEnv()
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      apikey: apiKey,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (!response.ok) {
    await throwEvolutionError(response)
  }
  // Some endpoints (logout/delete) may answer with an empty body.
  const text = await response.text()
  return (text ? JSON.parse(text) : {}) as T
}

const enc = encodeURIComponent

/**
 * Deterministic instance name for an account. One instance per account
 * matches `whatsapp_config`'s UNIQUE(account_id).
 */
export function evolutionInstanceNameForAccount(accountId: string): string {
  return `wacrm_${accountId.replace(/-/g, '')}`
}

/**
 * Evolution addresses recipients by bare digits (`5511999999999`); it
 * resolves the `@s.whatsapp.net` JID itself.
 */
export function toEvolutionNumber(phone: string): string {
  return phone.replace(/\D/g, '')
}

// ============================================================
// Instances
// ============================================================

export interface EvolutionQrCode {
  /** `data:image/png;base64,...` ready for an <img src>. */
  base64: string | null
  /** Raw pairing string encoded in the QR. */
  code: string | null
  /** 8-char code for "link with phone number" when requested. */
  pairingCode: string | null
}

interface RawQrPayload {
  base64?: string | null
  code?: string | null
  pairingCode?: string | null
}

function toQrCode(raw: RawQrPayload | undefined | null): EvolutionQrCode {
  return {
    base64: raw?.base64 ?? null,
    code: raw?.code ?? null,
    pairingCode: raw?.pairingCode ?? null,
  }
}

export interface CreateEvolutionInstanceArgs {
  instanceName: string
  /** Absolute URL of wacrm's Evolution webhook route. */
  webhookUrl: string
  /** Plaintext secret Evolution sends back in {@link EVOLUTION_WEBHOOK_SECRET_HEADER}. */
  webhookSecret: string
}

export interface CreateEvolutionInstanceResult {
  instanceName: string
  qrcode: EvolutionQrCode
}

/**
 * Create a Baileys instance with its webhook pre-configured. `base64:
 * true` makes Evolution embed inbound media bytes in `messages.upsert`,
 * so the webhook never has to call back for them.
 */
export async function createEvolutionInstance(
  args: CreateEvolutionInstanceArgs,
): Promise<CreateEvolutionInstanceResult> {
  const { instanceName, webhookUrl, webhookSecret } = args
  const data = await evolutionRequest<{
    instance?: { instanceName?: string }
    qrcode?: RawQrPayload
  }>('POST', '/instance/create', {
    instanceName,
    integration: 'WHATSAPP-BAILEYS',
    qrcode: true,
    groupsIgnore: true,
    alwaysOnline: false,
    readMessages: false,
    webhook: {
      enabled: true,
      url: webhookUrl,
      byEvents: false,
      base64: true,
      headers: { [EVOLUTION_WEBHOOK_SECRET_HEADER]: webhookSecret },
      events: EVOLUTION_WEBHOOK_EVENTS,
    },
  })
  return {
    instanceName: data.instance?.instanceName ?? instanceName,
    qrcode: toQrCode(data.qrcode),
  }
}

export interface SetEvolutionWebhookArgs {
  instanceName: string
  webhookUrl: string
  webhookSecret: string
}

/**
 * (Re)apply the webhook config on an existing instance — used when the
 * instance already existed (reconnect) or the public URL changed.
 */
export async function setEvolutionWebhook(args: SetEvolutionWebhookArgs): Promise<void> {
  const { instanceName, webhookUrl, webhookSecret } = args
  await evolutionRequest('POST', `/webhook/set/${enc(instanceName)}`, {
    webhook: {
      enabled: true,
      url: webhookUrl,
      byEvents: false,
      base64: true,
      headers: { [EVOLUTION_WEBHOOK_SECRET_HEADER]: webhookSecret },
      events: EVOLUTION_WEBHOOK_EVENTS,
    },
  })
}

/** Fetch a fresh QR code (also (re)starts the pairing session). */
export async function getEvolutionQrCode(args: {
  instanceName: string
}): Promise<EvolutionQrCode> {
  const data = await evolutionRequest<RawQrPayload>(
    'GET',
    `/instance/connect/${enc(args.instanceName)}`,
  )
  return toQrCode(data)
}

export type EvolutionConnectionState = 'open' | 'connecting' | 'close'

export async function getEvolutionConnectionState(args: {
  instanceName: string
}): Promise<EvolutionConnectionState> {
  const data = await evolutionRequest<{ instance?: { state?: string } }>(
    'GET',
    `/instance/connectionState/${enc(args.instanceName)}`,
  )
  return normalizeConnectionState(data.instance?.state)
}

/** Map Evolution/Baileys state strings onto the three states wacrm cares about. */
export function normalizeConnectionState(state: string | null | undefined): EvolutionConnectionState {
  if (state === 'open') return 'open'
  if (state === 'connecting') return 'connecting'
  return 'close'
}

/** Unpair the WhatsApp session but keep the instance. */
export async function logoutEvolutionInstance(args: { instanceName: string }): Promise<void> {
  await evolutionRequest('DELETE', `/instance/logout/${enc(args.instanceName)}`)
}

/** Remove the instance entirely (session + stored data on the Evolution side). */
export async function deleteEvolutionInstance(args: { instanceName: string }): Promise<void> {
  await evolutionRequest('DELETE', `/instance/delete/${enc(args.instanceName)}`)
}

// ============================================================
// Messages
// ============================================================

export interface EvolutionSendResult {
  /** WhatsApp message id (`key.id`) — stored in `messages.message_id`. */
  messageId: string
}

interface RawSendResponse {
  key?: { id?: string }
}

function toSendResult(data: RawSendResponse): EvolutionSendResult {
  const messageId = data.key?.id
  if (!messageId) {
    throw new EvolutionApiError('Evolution API did not return a message id', 502)
  }
  return { messageId }
}

interface BaseSendArgs {
  instanceName: string
  /** Recipient phone in any format; normalised to digits. */
  to: string
  /** WhatsApp id of the message being replied to. */
  quotedMessageId?: string
}

function quoted(id: string | undefined) {
  return id ? { quoted: { key: { id } } } : {}
}

export async function sendEvolutionText(
  args: BaseSendArgs & { text: string },
): Promise<EvolutionSendResult> {
  const data = await evolutionRequest<RawSendResponse>(
    'POST',
    `/message/sendText/${enc(args.instanceName)}`,
    {
      number: toEvolutionNumber(args.to),
      text: args.text,
      ...quoted(args.quotedMessageId),
    },
  )
  return toSendResult(data)
}

export type EvolutionMediaKind = 'image' | 'video' | 'document'

export async function sendEvolutionMedia(
  args: BaseSendArgs & {
    kind: EvolutionMediaKind
    /** Public URL (or base64) of the file. */
    media: string
    mimeType?: string
    caption?: string
    fileName?: string
  },
): Promise<EvolutionSendResult> {
  const data = await evolutionRequest<RawSendResponse>(
    'POST',
    `/message/sendMedia/${enc(args.instanceName)}`,
    {
      number: toEvolutionNumber(args.to),
      mediatype: args.kind,
      media: args.media,
      ...(args.mimeType ? { mimetype: args.mimeType } : {}),
      ...(args.caption ? { caption: args.caption } : {}),
      ...(args.fileName ? { fileName: args.fileName } : {}),
      ...quoted(args.quotedMessageId),
    },
  )
  return toSendResult(data)
}

/**
 * Send audio as a voice note (PTT) — shows in WhatsApp as recorded on
 * the spot. `encoding: true` lets Evolution transcode to Opus.
 */
export async function sendEvolutionAudio(
  args: BaseSendArgs & { audio: string },
): Promise<EvolutionSendResult> {
  const data = await evolutionRequest<RawSendResponse>(
    'POST',
    `/message/sendWhatsAppAudio/${enc(args.instanceName)}`,
    {
      number: toEvolutionNumber(args.to),
      audio: args.audio,
      encoding: true,
      ...quoted(args.quotedMessageId),
    },
  )
  return toSendResult(data)
}

/**
 * Download an inbound message's media as base64. Fallback for when the
 * webhook payload arrived without embedded bytes.
 */
export async function getEvolutionMediaBase64(args: {
  instanceName: string
  messageId: string
}): Promise<{ base64: string; mimeType: string | null }> {
  const data = await evolutionRequest<{ base64?: string; mimetype?: string }>(
    'POST',
    `/chat/getBase64FromMediaMessage/${enc(args.instanceName)}`,
    { message: { key: { id: args.messageId } }, convertToMp4: false },
  )
  if (!data.base64) {
    throw new EvolutionApiError('Evolution API returned no media', 502)
  }
  return { base64: data.base64, mimeType: data.mimetype ?? null }
}
