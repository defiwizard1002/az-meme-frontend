export function streamBatchItems<T>(data: T | { items: T[] }): T[] {
  if (typeof data === 'object' && data !== null && 'items' in data && Array.isArray(data.items)) return data.items;
  return [data as T];
}

export function streamSequenceAction(previous: { epoch: string; sequence: number } | undefined,
  next: { epoch: string; sequence: number }): 'APPLY' | 'DUPLICATE' | 'RESYNC' {
  if (!previous) return 'APPLY';
  if (previous.epoch !== next.epoch) return 'RESYNC';
  if (next.sequence <= previous.sequence) return 'DUPLICATE';
  return next.sequence === previous.sequence + 1 ? 'APPLY' : 'RESYNC';
}
