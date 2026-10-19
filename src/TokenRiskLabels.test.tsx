import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { TokenRiskLabels } from './TokenRiskLabels';
import type { Token } from './types';

afterEach(cleanup);

it.each([
  { isHoneypot: true, isShowAlert: true, honeypot: '是', alert: '有' },
  { isHoneypot: false, isShowAlert: false, honeypot: '否', alert: '无' },
  { isHoneypot: null, isShowAlert: null, honeypot: '未知', alert: '未知' },
  { isHoneypot: null, isShowAlert: true, honeypot: '未知', alert: '有' },
  { isHoneypot: undefined, isShowAlert: undefined, honeypot: '未知', alert: '未知' },
])('renders independent risk states: $honeypot / $alert', ({ isHoneypot, isShowAlert, honeypot, alert }) => {
  render(<TokenRiskLabels security={{ isHoneypot, isShowAlert } as Token['security']} />);
  const honeypotLabel = screen.getByText(`貔貅：${honeypot}`);
  const alertLabel = screen.getByText(`风险提示：${alert}`);
  expect(honeypotLabel).toBeVisible();
  expect(alertLabel).toBeVisible();
  expect(honeypotLabel).toHaveClass(isHoneypot === true ? 'security-danger' : 'security-neutral');
  expect(alertLabel).toHaveClass(isShowAlert === true ? 'security-warning' : 'security-neutral');
});
