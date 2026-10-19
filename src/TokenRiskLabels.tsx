import type { Token } from './types';

export function TokenRiskLabels({ security }: { security: Token['security'] }) {
  return <>
    <span className={security.isHoneypot === true ? 'security-danger' : 'security-neutral'}>
      貔貅：{security.isHoneypot === true ? '是' : security.isHoneypot === false ? '否' : '未知'}
    </span>
    <span className={security.isShowAlert === true ? 'security-warning' : 'security-neutral'}>
      风险提示：{security.isShowAlert === true ? '有' : security.isShowAlert === false ? '无' : '未知'}
    </span>
  </>;
}
