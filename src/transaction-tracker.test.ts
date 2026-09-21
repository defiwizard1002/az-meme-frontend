import { afterEach, describe, expect, it, vi } from 'vitest';
import { pollTransactionUntilTerminal } from './transaction-tracker';
import type { AccountTransaction } from './types';

const pending: AccountTransaction = {
  executionId: 'execution-1',
  tokenAddress: '0x1111111111111111111111111111111111111111',
  tokenSymbol: 'MEME',
  side: 'BUY',
  settlementAsset: 'USDG',
  amountIn: '0.1',
  amountOut: null,
  status: 'PENDING',
  txHashes: [],
  errorMessage: null,
  createdAt: 1,
  updatedAt: 1,
};

describe('main-account transaction tracking', () => {
  afterEach(() => vi.useRealTimers());

  it('polls until the transaction is confirmed', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const tracking = pollTransactionUntilTerminal(pending.executionId, {
      signal: new AbortController().signal,
      pollIntervalMs: 1_000,
      loadTransaction: async () => ++calls === 2 ? { ...pending, status: 'CONFIRMED' } : pending,
      onUpdate: vi.fn(),
    });

    await vi.advanceTimersByTimeAsync(1_000);

    await expect(tracking).resolves.toMatchObject({ status: 'CONFIRMED' });
    expect(calls).toBe(2);
  });

  it('treats an unknown submission result as terminal and never resubmits', async () => {
    const loadTransaction = vi.fn().mockResolvedValue({ ...pending, status: 'SUBMISSION_UNKNOWN' });
    await expect(pollTransactionUntilTerminal(pending.executionId, {
      signal: new AbortController().signal,
      loadTransaction,
      onUpdate: vi.fn(),
    })).resolves.toMatchObject({ status: 'SUBMISSION_UNKNOWN' });
    expect(loadTransaction).toHaveBeenCalledTimes(1);
  });
});
