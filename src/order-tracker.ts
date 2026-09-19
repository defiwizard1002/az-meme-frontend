import type { Order } from './types';

interface PollOrderOptions {
  signal: AbortSignal;
  loadOrder(orderId: string): Promise<Order>;
  onUpdate(order: Order): void;
  onTemporaryError?(cause: unknown): void;
  pollIntervalMs?: number;
  maxRetryIntervalMs?: number;
}

function isTerminal(order: Order): boolean {
  return order.status === 'SETTLED'
    || (order.status === 'FAILED_FINAL' && order.fundStatus === 'RELEASED');
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

export async function pollOrderUntilTerminal(orderId: string, options: PollOrderOptions): Promise<Order | null> {
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const maxRetryIntervalMs = options.maxRetryIntervalMs ?? 5_000;
  let consecutiveErrors = 0;
  while (!options.signal.aborted) {
    try {
      const order = await options.loadOrder(orderId);
      consecutiveErrors = 0;
      options.onUpdate(order);
      if (isTerminal(order)) return order;
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
