import { useEffect, useRef } from 'react';
import type { AccountTransaction } from './types';
import { displayAmount } from './decimal-display';

export function HistoryModal({items,error,loading,onClose,explorer}:{items:AccountTransaction[];error:string|null;loading:boolean;onClose:()=>void;explorer:string}) {
 const dialog=useRef<HTMLDivElement>(null);
 useEffect(()=>{
  const trigger=document.activeElement as HTMLElement|null;
  dialog.current?.focus();
  return ()=>trigger?.focus();
 },[]);
 return <div className="modal-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)onClose();}}>
  <div ref={dialog} className="history-dialog" role="dialog" aria-modal="true" aria-labelledby="history-title" tabIndex={-1} onKeyDown={e=>{
   if(e.key==='Escape'){e.stopPropagation();onClose();}
   if(e.key==='Tab'){
    const nodes=dialog.current?.querySelectorAll<HTMLElement>('button,a[href]');
    if(!nodes?.length)return;
    const first=nodes[0]!,last=nodes[nodes.length-1]!;
    if(e.shiftKey&&(document.activeElement===first||document.activeElement===dialog.current)){e.preventDefault();last.focus();}
    else if(!e.shiftKey&&(document.activeElement===last||document.activeElement===dialog.current)){e.preventDefault();first.focus();}
   }
  }}>
   <header><div><h2 id="history-title">交易记录</h2><span>{items.length} 笔交易</span></div><button type="button" className="icon-button" aria-label="关闭交易记录" onClick={onClose}>×</button></header>
   {error&&<div className="history-error" role="alert">{error}</div>}
   <div className="history-scroll" aria-busy={loading}>
    {!items.length?<div className="transaction-empty">{loading?'正在加载交易记录':'暂无交易'}</div>:items.map(tx=><div className="account-transaction" key={tx.executionId}>
     <span><b className={tx.side==='BUY'?'positive':'negative'}>{tx.side==='BUY'?'买入':'卖出'} {tx.tokenSymbol}</b><small>{displayAmount(tx.amountIn)} {tx.side==='BUY'?tx.settlementAsset:tx.tokenSymbol}{tx.amountOut?` → ${displayAmount(tx.amountOut)} ${tx.side==='BUY'?tx.tokenSymbol:tx.settlementAsset}`:''}</small><time dateTime={new Date(tx.createdAt).toISOString()}>{new Date(tx.createdAt).toLocaleString()}</time></span>
     <span className={`transaction-status status-${tx.status.toLowerCase()}`}>{({CONFIRMED:'已完成',FAILED:'失败',PARTIAL:'部分完成',SUBMISSION_UNKNOWN:'待确认',PENDING:'处理中'})[tx.status]}</span>
     <span className="transaction-links">{tx.txHashes.map((hash,index)=>explorer&&/^0x[a-fA-F0-9]{64}$/.test(hash)?<a href={`${explorer.replace(/\/+$/,'')}/tx/${hash}`} target="_blank" rel="noreferrer" key={hash}>Tx{index+1} ↗</a>:null)}</span>
    </div>)}
   </div>
  </div>
 </div>;
}
