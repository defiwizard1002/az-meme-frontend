import type { SponsoredTransaction } from "./api";
export async function sendSponsoredTransaction(
  tx: SponsoredTransaction,
  address: string,
  chainId: number,
  send: (
    tx: { to: string; data: `0x${string}`; value: bigint; chainId: number },
    options: { sponsor: true; address: string; uiOptions: { showWalletUIs: false } },
  ) => Promise<{ hash: `0x${string}` }>,
): Promise<`0x${string}`> {
  if (tx.from.toLowerCase() !== address.toLowerCase()) throw new Error("交易发起钱包不匹配");
  return (
    await send(
      { to: tx.to, data: tx.data, value: BigInt(tx.value), chainId },
      { sponsor: true, address, uiOptions: { showWalletUIs: false } },
    )
  ).hash;
}
