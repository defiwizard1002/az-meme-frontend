import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, memeApi, setSessionToken } from './api';
afterEach(() => { vi.unstubAllGlobals(); setSessionToken(null); });
describe('HTTP envelopes', () => {
  it.each([[502, ''], [503, '<html>unavailable</html>'], [401, 'Unauthorized']])('preserves HTTP %i for a non-JSON body', async (status, body) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { status: status as number })));
    await expect(memeApi.getAccount()).rejects.toMatchObject({ status, code: 'MEME_REQUEST_FAILED', message: expect.stringContaining(`HTTP ${status}`) });
  });
  it('rejects empty successful responses as protocol errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('')));
    await expect(memeApi.getAccount()).rejects.toMatchObject({ status: 200, code: 'MEME_INVALID_RESPONSE', message: 'HTTP 200: 服务响应无效，请稍后重试' });
  });
  it('preserves backend error envelopes and authorization on mutation', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ rc: 1, mc: 'MEME_UNAUTHORIZED', ma: ['Session expired'], result: null }), { status: 401 }));
    vi.stubGlobal('fetch', fetch); setSessionToken('test-session');
    await expect(memeApi.createOrder({ clientOrderId: 'a', quoteId: 'b', maxAmountIn: '1', minAmountOut: '1' })).rejects.toEqual(new ApiError('MEME_UNAUTHORIZED', 'Session expired', 401));
    expect((fetch.mock.calls[0]![1].headers as Headers).get('authorization')).toBe('Bearer test-session');
  });
});
