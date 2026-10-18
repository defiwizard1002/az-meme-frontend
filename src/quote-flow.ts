import type { Asset, Quote, QuoteDisplay } from './types';
export type QuoteRequest = { side:'BUY'|'SELL';tokenAddress:string;settlementAsset:Asset;amountIn:string;slippageBps:number;purpose?:'ESTIMATE'|'PREPARE_EXECUTION';minAmountOut?:string };
function decimal(value:string):[bigint,number]{
 if(!/^\d+(?:\.\d+)?$/.test(value))throw Error('金额格式无效');
 const [whole,fraction='']=value.split('.');return [BigInt(whole!+fraction),fraction.length];
}
export function compareAmounts(a:string,b:string):number{
 const [av,ad]=decimal(a),[bv,bd]=decimal(b),d=Math.max(ad,bd),left=av*10n**BigInt(d-ad),right=bv*10n**BigInt(d-bd);return left<right?-1:left>right?1:0;
}
export function matchesDraft(q:QuoteDisplay,r:QuoteRequest):boolean{
 return q.tokenAddress.toLowerCase()===r.tokenAddress.toLowerCase()&&q.side===r.side&&q.settlementAsset===r.settlementAsset&&compareAmounts(q.amountIn,r.amountIn)===0;
}
export function withSlippageMinimum(quote:QuoteDisplay,slippageBps:number):QuoteDisplay{
 if(quote.status!=='LOCAL_ESTIMATE')return quote;
 const decimals=quote.outputDecimals;
 if(!Number.isInteger(slippageBps)||slippageBps<1||slippageBps>3000||!Number.isInteger(decimals)||decimals<0||decimals>255
  ||!/^\d+$/.test(quote.expectedAmountOutAtomic))throw Error('报价精度无效，请刷新报价');
 const [value,scale]=decimal(quote.expectedAmountOut);
 const expected=BigInt(quote.expectedAmountOutAtomic);
 if(scale>decimals||value*10n**BigInt(decimals-scale)!==expected)throw Error('报价数量与精度不一致，请刷新报价');
 const minimum=expected*BigInt(10000-slippageBps)/10000n;
 const digits=minimum.toString().padStart(decimals+1,'0');
 const minAmountOut=decimals?`${digits.slice(0,-decimals)}.${digits.slice(-decimals)}`.replace(/\.?0+$/,''):digits;
 return {...quote,minAmountOut};
}
export function preparationInput(request:QuoteRequest,estimate:QuoteDisplay):QuoteRequest{
 if(!matchesDraft(estimate,request))throw Error('估计与当前输入不匹配');
 if(estimate.expiresAt<=Date.now())throw Error('报价已过期，请等待新报价后重新准备');
 return {...request,purpose:'PREPARE_EXECUTION',amountIn:request.amountIn,minAmountOut:request.minAmountOut??estimate.minAmountOut};
}
export function requirePreparedQuote(value:QuoteDisplay,request:QuoteRequest,now=Date.now()):Quote{
 if(value.status==='LOCAL_ESTIMATE'||!value.quoteId)throw Error('准备未完成：估计不能提交交易；如需授权，请授权后重新准备并确认');
 if(!matchesDraft(value,request))throw Error('准备结果与当前输入不匹配');
 if(value.expiresAt<=now)throw Error('准备结果已过期，请重新准备并确认');
 if(request.minAmountOut===undefined||compareAmounts(value.minAmountOut,request.minAmountOut)<0)throw Error('准备结果不能降低最低得到');
 if(compareAmounts(value.minAmountOut,request.minAmountOut)!==0)throw Error('最低得到与确认值不一致，请重新准备并确认');
 if(!value.routeFingerprint||!value.routePools?.length||!value.routeAssets||value.routeAssets.length<2)throw Error('准备结果缺少路径，请重新准备');
 return value as Quote;
}
