import type { AccountTransaction } from './types';

interface PollTransactionOptions {
  signal: AbortSignal;
  loadTransaction(executionId: string): Promise<AccountTransaction>;
  onUpdate(transaction: AccountTransaction): void;
  onTemporaryError?(cause: unknown): void;
  pollIntervalMs?: number;
  maxRetryIntervalMs?: number;
}

function isTerminal(transaction: AccountTransaction): boolean {
  return transaction.status !== 'PENDING';
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = window.setTimeout(finish, ms);
    function finish() {
      signal.removeEventListener('abort', finish);
      window.clearTimeout(timer);
      resolve();
    }
    signal.addEventListener('abort', finish, { once: true });
  });
}

export async function pollTransactionUntilTerminal(
  executionId: string,
  options: PollTransactionOptions,
): Promise<AccountTransaction | null> {
  const pollIntervalMs = options.pollIntervalMs ?? 500;
  const maxRetryIntervalMs = options.maxRetryIntervalMs ?? 5_000;
  let consecutiveErrors = 0;
  while (!options.signal.aborted) {
    try {
      const transaction = await options.loadTransaction(executionId);
      consecutiveErrors = 0;
      options.onUpdate(transaction);
      if (isTerminal(transaction)) return transaction;
      await wait(pollIntervalMs, options.signal);
    } catch (cause) {
      if (options.signal.aborted) break;
      consecutiveErrors += 1;
      options.onTemporaryError?.(cause);
      const retryMs = Math.min(maxRetryIntervalMs, pollIntervalMs * 2 ** Math.min(consecutiveErrors, 6));
      await wait(retryMs, options.signal);
    }
  }
  return null;
}
