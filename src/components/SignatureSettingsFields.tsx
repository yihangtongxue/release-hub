import { Form, Input, Select } from 'antd';
import { normalizeSignatureSettings } from '../shared/signature-policy';

export function SignatureSettingsFields() {
  return (
    <>
      <Form.Item
        name="signaturePolicy"
        label="更新包签名"
        rules={[{ required: true, message: '请选择签名策略' }]}
        extra="可选：有签名就验证；必须签名：每个安装包都需要同目录的 .sig.json。"
      >
        <Select placeholder="请选择签名策略" options={[
          { value: 'optional', label: '签名可选' },
          { value: 'required', label: '必须签名' },
        ]} />
      </Form.Item>
      <Form.Item
        name="signatureAppId"
        label="应用标识"
        dependencies={['signaturePolicy']}
        extra="必须签名时必填，与客户端和签名工具中的 appId 一致；可选模式填写后也会检查。"
        rules={[({ getFieldValue }) => ({ validator: (_rule, value) => {
          const signaturePolicy = getFieldValue('signaturePolicy');
          if (!signaturePolicy) return Promise.resolve();
          try {
            normalizeSignatureSettings({ signaturePolicy, signatureAppId: value });
            return Promise.resolve();
          } catch (error) { return Promise.reject(error); }
        } })]}
      >
        <Input placeholder="例如：com.example.desktop" maxLength={255} />
      </Form.Item>
    </>
  );
}
