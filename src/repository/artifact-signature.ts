import { createHash, createPublicKey, verify } from 'node:crypto';
import { open } from 'node:fs/promises';
import type { BuildAssetInput, UpdateSignature } from '../shared/product';
import { normalizeSignatureSettings } from '../shared/signature-policy';
import type { SignatureSettings } from '../shared/signature-policy';

function decode(value: unknown, length?: number): Buffer {
  if (typeof value !== 'string' || value.length > 16384 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new Error('签名文件编码无效');
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value || (length !== undefined && bytes.length !== length)) {
    throw new Error('签名文件编码或长度无效');
  }
  return bytes;
}

export async function readArtifactSignature(
  asset: BuildAssetInput, version: string, metadata: { size: number; sha256: string }, settings: SignatureSettings,
): Promise<UpdateSignature | undefined> {
  const { signaturePolicy, signatureAppId } = normalizeSignatureSettings(settings);
  let file: Awaited<ReturnType<typeof open>>;
  try {
    file = await open(`${asset.filePath}.sig.json`, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      if (signaturePolicy === 'optional') return undefined;
      throw new Error(`${asset.fileName} 缺少签名文件，请保留同目录的 .sig.json 文件后重新发布`);
    }
    throw new Error(`${asset.fileName} 的签名文件无法读取，请检查文件权限和路径`);
  }
  try {
    const buffer = Buffer.alloc(32769);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 32768 || !(await file.stat()).isFile()) throw new Error('签名文件过大或不是普通文件');
    const sidecar = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
    if (!sidecar || typeof sidecar !== 'object' || Array.isArray(sidecar)) throw new Error('签名文件格式无效');
    const publicKey = decode(sidecar.publicKey, 32);
    if (sidecar.algorithm !== 'ed25519' || sidecar.keyId !== createHash('sha256').update(publicKey).digest('hex')) {
      throw new Error('签名算法或公钥标识无效');
    }
    const payload = decode(sidecar.payload);
    const signature = decode(sidecar.signature, 64);
    const key = createPublicKey({
      key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), publicKey]),
      format: 'der', type: 'spki',
    });
    if (!verify(null, payload, key, signature)) throw new Error('发布者签名验证失败');
    const signed = JSON.parse(payload.toString('utf8'));
    if (!signed || typeof signed !== 'object' || Array.isArray(signed)) throw new Error('签名载荷格式无效');
    const expected = { schemaVersion: 1, appId: signatureAppId ?? signed.appId,
      channel: 'stable', version, platform: asset.platform, architecture: asset.architecture,
      packageType: asset.packageType, fileName: asset.fileName, size: metadata.size, sha256: metadata.sha256 };
    if (!signed || typeof signed.appId !== 'string' || !signed.appId ||
        Object.keys(signed).length !== Object.keys(expected).length ||
        Object.entries(expected).some(([key, value]) => signed[key] !== value)) {
      throw new Error('签名中的版本、目标或文件校验值不匹配，请重新签名');
    }
    // Public key here only validates sidecar consistency. Clients MUST use their
    // embedded trust anchor, not trust a public key supplied by this manifest.
    return { algorithm: 'ed25519', keyId: sidecar.keyId, payload: sidecar.payload, signature: sidecar.signature };
  } finally {
    await file.close();
  }
}
