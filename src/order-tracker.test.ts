import { afterEach, describe, expect, it, vi } from 'vitest';
import { pollOrderUntilTerminal } from './order-tracker';
import type { Order } from './types';

const pending: Order = { orderId: 'order-1', status: 'SUBMISSION_UNKNOWN', fundStatus: 'RESERVED' };

describe('order tracking', () => {
  afterEach(() => vi.useRealTimers());

  it('continues beyond the old 40-poll limit until a terminal order is observed', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const onUpdate = vi.fn();
    const tracking = pollOrderUntilTerminal('order-1', {
      signal: new AbortController().signal,
      pollIntervalMs: 1_000,
      loadOrder: async () => {
        calls += 1;
        return calls > 45 ? { ...pending, status: 'SETTLED', fundStatus: 'SETTLED' } : pending;
      },
      onUpdate,
    });

    await vi.advanceTimersByTimeAsync(46_000);

    await expect(tracking).resolves.toMatchObject({ status: 'SETTLED' });
    expect(onUpdate).toHaveBeenCalledTimes(46);
  });

  it('retries a temporary read failure and stops cleanly when aborted', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const loadOrder = vi.fn()
      .mockRejectedValueOnce(new Error('temporary'))
      .mockResolvedValue(pending);
    const onTemporaryError = vi.fn();
    const tracking = pollOrderUntilTerminal('order-1', {
      signal: controller.signal,
      pollIntervalMs: 1_000,
      loadOrder,
      onUpdate: vi.fn(),
      onTemporaryError,
    });

    await vi.advanceTimersByTimeAsync(2_000);
    expect(onTemporaryError).toHaveBeenCalledTimes(1);
    expect(loadOrder).toHaveBeenCalledTimes(2);
    controller.abort();
    await expect(tracking).resolves.toBeNull();
  });
});
