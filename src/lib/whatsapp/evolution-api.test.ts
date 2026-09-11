import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EVOLUTION_WEBHOOK_SECRET_HEADER,
  EvolutionApiError,
  createEvolutionInstance,
  evolutionInstanceNameForAccount,
  getEvolutionConnectionState,
  getEvolutionQrCode,
  logoutEvolutionInstance,
  normalizeConnectionState,
  sendEvolutionAudio,
  sendEvolutionMedia,
  sendEvolutionText,
  toEvolutionNumber,
} from './evolution-api';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('evolution-api', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.stubEnv('EVOLUTION_API_URL', 'http://evo.local:8080/');
    vi.stubEnv('EVOLUTION_API_KEY', 'global-key');
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  describe('helpers', () => {
    it('derives a stable instance name from the account id', () => {
      expect(
        evolutionInstanceNameForAccount('0b3c2a10-1111-2222-3333-444455556666'),
      ).toBe('wacrm_0b3c2a10111122223333444455556666');
    });

    it('strips everything but digits from phone numbers', () => {
      expect(toEvolutionNumber('+55 (11) 99999-9999')).toBe('5511999999999');
    });

    it('normalises connection states', () => {
      expect(normalizeConnectionState('open')).toBe('open');
      expect(normalizeConnectionState('connecting')).toBe('connecting');
      expect(normalizeConnectionState('close')).toBe('close');
      expect(normalizeConnectionState('refused')).toBe('close');
      expect(normalizeConnectionState(undefined)).toBe('close');
    });
  });

  it('fails clearly when env vars are missing', async () => {
    vi.stubEnv('EVOLUTION_API_KEY', '');
    await expect(
      getEvolutionConnectionState({ instanceName: 'x' }),
    ).rejects.toThrow(/EVOLUTION_API_URL and EVOLUTION_API_KEY/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('creates an instance with the webhook secret header and base64 media', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(201, {
        instance: { instanceName: 'wacrm_abc' },
        qrcode: { base64: 'data:image/png;base64,AAA', code: '2@xyz' },
      }),
    );

    const result = await createEvolutionInstance({
      instanceName: 'wacrm_abc',
      webhookUrl: 'http://host.docker.internal:3000/api/whatsapp/evolution/webhook',
      webhookSecret: 's3cret',
    });

    expect(result).toEqual({
      instanceName: 'wacrm_abc',
      qrcode: { base64: 'data:image/png;base64,AAA', code: '2@xyz', pairingCode: null },
    });

    const [url, init] = fetchMock.mock.calls[0];
    // Trailing slash on the base URL must not produce `//instance`.
    expect(url).toBe('http://evo.local:8080/instance/create');
    expect(init.method).toBe('POST');
    expect(init.headers.apikey).toBe('global-key');
    const body = JSON.parse(init.body);
    expect(body.integration).toBe('WHATSAPP-BAILEYS');
    expect(body.webhook.base64).toBe(true);
    expect(body.webhook.headers[EVOLUTION_WEBHOOK_SECRET_HEADER]).toBe('s3cret');
    expect(body.webhook.events).toContain('MESSAGES_UPSERT');
  });

  it('reads the QR code and connection state', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { base64: 'data:image/png;base64,BBB', code: 'c' }))
      .mockResolvedValueOnce(jsonResponse(200, { instance: { instanceName: 'i', state: 'open' } }));

    expect(await getEvolutionQrCode({ instanceName: 'wacrm abc' })).toEqual({
      base64: 'data:image/png;base64,BBB',
      code: 'c',
      pairingCode: null,
    });
    expect(fetchMock.mock.calls[0][0]).toBe(
      'http://evo.local:8080/instance/connect/wacrm%20abc',
    );

    expect(await getEvolutionConnectionState({ instanceName: 'i' })).toBe('open');
  });

  it('tolerates an empty body on logout', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 200 }));
    await expect(logoutEvolutionInstance({ instanceName: 'i' })).resolves.toBeUndefined();
    expect(fetchMock.mock.calls[0][1].method).toBe('DELETE');
  });

  it('sends text with digits-only number and quoted reply', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(201, { key: { id: 'WAMID1' } }));

    const result = await sendEvolutionText({
      instanceName: 'i',
      to: '+351 912 345 678',
      text: 'Olá',
      quotedMessageId: 'PARENT',
    });

    expect(result).toEqual({ messageId: 'WAMID1' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://evo.local:8080/message/sendText/i');
    expect(JSON.parse(init.body)).toEqual({
      number: '351912345678',
      text: 'Olá',
      quoted: { key: { id: 'PARENT' } },
    });
  });

  it('sends media and voice notes', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(201, { key: { id: 'M1' } }))
      .mockResolvedValueOnce(jsonResponse(201, { key: { id: 'A1' } }));

    await sendEvolutionMedia({
      instanceName: 'i',
      to: '5511999999999',
      kind: 'document',
      media: 'https://cdn/x.pdf',
      fileName: 'x.pdf',
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      number: '5511999999999',
      mediatype: 'document',
      media: 'https://cdn/x.pdf',
      fileName: 'x.pdf',
    });

    const audio = await sendEvolutionAudio({
      instanceName: 'i',
      to: '5511999999999',
      audio: 'https://cdn/voice.ogg',
    });
    expect(audio.messageId).toBe('A1');
    expect(fetchMock.mock.calls[1][0]).toBe(
      'http://evo.local:8080/message/sendWhatsAppAudio/i',
    );
  });

  it('surfaces nested Evolution error messages with the HTTP status', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(400, {
        status: 400,
        error: 'Bad Request',
        response: { message: ['Number not on WhatsApp', 'extra'] },
      }),
    );

    const err = await sendEvolutionText({ instanceName: 'i', to: '1', text: 'x' }).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(EvolutionApiError);
    expect(err.status).toBe(400);
    expect(err.message).toBe('Number not on WhatsApp; extra');
  });

  it('rejects a send response without a message id', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(201, {}));
    await expect(
      sendEvolutionText({ instanceName: 'i', to: '1', text: 'x' }),
    ).rejects.toThrow(/did not return a message id/);
  });
});
