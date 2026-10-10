import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, azAuth, memeApi, setSessionToken } from './api';
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); setSessionToken(null); });
describe('HTTP envelopes', () => {
  it('keeps public market reads and recovery tickets free of stale account credentials', async () => {
    const fetch = vi.fn(async (_input: string, _init: RequestInit) => new Response(JSON.stringify({ rc: 0, result: {} })));
    vi.stubGlobal('fetch', fetch); setSessionToken('stale-account-session');
    const controller = new AbortController();
    await memeApi.getConfig(); await memeApi.getMarkets(); await memeApi.searchMarkets('ORBANCY');
    await memeApi.getToken('token'); await memeApi.getCandles('token', '1s'); await memeApi.getTrades('token');
    await memeApi.getWsTicket(controller.signal, true);
    expect(fetch).toHaveBeenCalledTimes(7);
    for (const [, init] of fetch.mock.calls) {
      expect(new Headers(init.headers).has('authorization')).toBe(false);
      expect(init.credentials).toBe('omit');
    }
    expect(fetch.mock.calls.some(([url]) => String(url).includes('/az-auth'))).toBe(false);
    await memeApi.getAccount();
    expect(new Headers(fetch.mock.calls.at(-1)![1].headers).get('authorization')).toBe('Bearer stale-account-session');
  });
  it.each([[502, ''], [503, '<html>unavailable</html>'], [401, 'Unauthorized'], [502, '{"rc":1,']])('preserves HTTP %i for a non-JSON body', async (status, body) => {
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

describe('bounded HTTP requests', () => {
  it('cleans up its deadline and caller listener after success', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ rc: 0, result: { quoteBalances: [], positions: [] } }))));
    await memeApi.getAccount(controller.signal);
    expect(vi.getTimerCount()).toBe(0);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(controller.signal.aborted).toBe(false);
  });

  it('does not let canceled AZ login overwrite the retried session', async () => {
    const envelope = (result: unknown) => new Response(JSON.stringify({ rc: 0, result }));
    let finishOld!: (response: Response) => void;
    let logins = 0;
    const fetch = vi.fn().mockImplementation(async (input: string) => {
      if (input.endsWith('/get-nonce')) return envelope({ message: 'sign' });
      if (input.endsWith('/login')) {
        if (++logins === 1) return new Promise<Response>((resolve) => { finishOld = resolve; });
        return envelope({ accessToken: 'new-session', expiresAt: 1 });
      }
      return envelope({});
    });
    vi.stubGlobal('fetch', fetch);
    const controller = new AbortController();
    const reason = new DOMException('old attempt', 'AbortError');
    const old = azAuth.loginMock(controller.signal).catch((cause) => cause);
    await vi.waitFor(() => expect(logins).toBe(1));
    controller.abort(reason);
    await azAuth.loginMock();
    finishOld(envelope({ accessToken: 'old-session', expiresAt: 1 }));
    expect(await old).toBe(reason);
    await memeApi.getAccount();
    expect(new Headers(fetch.mock.calls.at(-1)![1].headers).get('authorization')).toBe('Bearer new-session');
    expect(fetch.mock.calls.filter(([url]) => url.endsWith('/getDesensitizedUserInfo'))).toHaveLength(1);
  });

  it.each(['fetch', 'body'] as const)('bounds a never resolving %s, aborts it and does not retry', async (stage) => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockImplementation(() => stage === 'fetch' ? new Promise(() => {})
      : Promise.resolve({ status: 200, ok: true, text: () => new Promise(() => {}) }));
    vi.stubGlobal('fetch', fetch);
    let failure: unknown;
    void memeApi.getAccount().catch((cause) => { failure = cause; });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(failure).toMatchObject({ code: 'MEME_REQUEST_TIMEOUT', status: stage === 'body' ? 200 : 0, message: expect.stringContaining('超时') });
    expect(fetch.mock.calls[0]![1].signal.aborted).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses one deadline for headers and body', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => new Promise((resolve) => {
      setTimeout(() => resolve({ status: 200, ok: true, text: () => new Promise(() => {}) }), 10_000);
    })));
    let failure: unknown;
    void memeApi.getAccount().catch((cause) => { failure = cause; });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(failure).toMatchObject({ code: 'MEME_REQUEST_TIMEOUT', status: 200 });
  });

  it.each(['fetch', 'body', 'before'] as const)('preserves caller cancellation during %s including its reason', async (stage) => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockImplementation(() => stage === 'body'
      ? Promise.resolve({ status: 200, ok: true, text: () => new Promise(() => {}) }) : new Promise(() => {}));
    vi.stubGlobal('fetch', fetch);
    const controller = new AbortController();
    const reason = new DOMException('superseded attempt', 'AbortError');
    if (stage === 'before') controller.abort(reason);
    let failure: unknown;
    void memeApi.getCandles('token', '1m', { signal: controller.signal }).catch((cause) => { failure = cause; });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort(reason);
    await vi.advanceTimersByTimeAsync(0);
    expect(failure).toBe(reason);
    expect(vi.getTimerCount()).toBe(0);
    if (stage === 'before') expect(fetch).not.toHaveBeenCalled();
    else expect(fetch.mock.calls[0]![1].signal.aborted).toBe(true);
  });

  it.each([200, 502, 503])('maps truncated body stream errors retaining HTTP %i', async (status) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status, ok: status === 200,
      text: async () => { throw new SyntaxError('Unexpected end of JSON input'); } }));
    await expect(memeApi.getAccount()).rejects.toMatchObject({ status,
      code: status === 200 ? 'MEME_INVALID_RESPONSE' : 'MEME_REQUEST_FAILED', message: expect.stringContaining(`HTTP ${status}`) });
  });

  it.each(['{"rc":0,"result":', '<html>proxy</html>', 'null', '[]', '{}'])('maps malformed successful JSON %s', async (body) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body)));
    await expect(memeApi.getAccount()).rejects.toMatchObject({ status: 200, code: 'MEME_INVALID_RESPONSE' });
  });

  it('retains proxy status when its response body stalls', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 502, ok: false, text: () => new Promise(() => {}) }));
    let failure: unknown;
    void memeApi.getAccount().catch((cause) => { failure = cause; });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(failure).toMatchObject({ status: 502, code: 'MEME_REQUEST_FAILED', message: expect.stringContaining('超时') });
  });

  it('reports mutation timeout as unknown outcome, never rebroadcasts automatically', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockImplementation(() => new Promise(() => {}));
    vi.stubGlobal('fetch', fetch);
    let failure: unknown;
    void memeApi.executeMainAccountTrade({ clientExecutionId: 'same-id', side: 'BUY', tokenAddress: 'token',
      settlementAsset: 'USDG', amountIn: '1', slippageBps: 300 }).catch((cause) => { failure = cause; });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(failure).toMatchObject({ code: 'MEME_REQUEST_TIMEOUT', message: expect.stringContaining('可能已广播') });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
