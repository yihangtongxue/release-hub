import type { SignaturePolicy } from './product';

export interface SignatureSettings {
  signaturePolicy: SignaturePolicy;
  signatureAppId: string | null;
}

export function normalizeSignatureSettings(input: {
  signaturePolicy?: unknown;
  signatureAppId?: unknown;
}): SignatureSettings {
  if (input.signaturePolicy !== 'optional' && input.signaturePolicy !== 'required') {
    throw new Error('请在编辑产品中选择更新包签名策略后再发布');
  }
  if (input.signatureAppId != null && typeof input.signatureAppId !== 'string') {
    throw new Error('应用标识格式不正确');
  }
  const appId = typeof input.signatureAppId === 'string' ? input.signatureAppId.trim() : '';
  if (appId.length > 255 || /[\s\x00-\x1f\x7f]/.test(appId)) {
    throw new Error('应用标识最多 255 个字符，不能包含空白或控制字符');
  }
  if (input.signaturePolicy === 'required' && !appId) {
    throw new Error('必须签名的产品需要填写应用标识，与客户端和签名工具保持一致');
  }
  return { signaturePolicy: input.signaturePolicy, signatureAppId: appId || null };
}
