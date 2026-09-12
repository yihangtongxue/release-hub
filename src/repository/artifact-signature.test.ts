import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { readArtifactSignature } from './artifact-signature';
import { normalizeSignatureSettings } from '../shared/signature-policy';
import type { SignatureSettings } from '../shared/signature-policy';
import type { BuildAssetInput } from '../shared/product';

const required: SignatureSettings = { signaturePolicy: 'required', signatureAppId: 'com.example.desktop' };
const optional: SignatureSettings = { signaturePolicy: 'optional', signatureAppId: null };

// In-memory, disposable test keys only. No publisher key or network access.
async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'release-signature-'));
  const asset: BuildAssetInput = { filePath: path.join(directory, 'Example.zip'), fileName: 'Example.zip',
    platform: 'macos', architecture: 'arm64', packageType: 'zip' };
  const metadata = { size: 3, sha256: createHash('sha256').update('abc').digest('hex') };
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const publicBytes = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const payload = Buffer.from(JSON.stringify({ schemaVersion: 1, appId: 'com.example.desktop',
    channel: 'stable', version: '1.0.0', platform: asset.platform, architecture: asset.architecture,
    packageType: asset.packageType, fileName: asset.fileName, ...metadata }));
  const sidecar = { algorithm: 'ed25519', keyId: createHash('sha256').update(publicBytes).digest('hex'),
    publicKey: publicBytes.toString('base64'), payload: payload.toString('base64'),
    signature: sign(null, payload, privateKey).toString('base64') };
  await writeFile(`${asset.filePath}.sig.json`, JSON.stringify(sidecar));
  return { directory, asset, metadata, sidecar };
}

test('valid sidecar is forwarded without trusting or publishing its public key', async () => {
  const f = await fixture();
  try {
    const result = await readArtifactSignature(f.asset, '1.0.0', f.metadata, required);
    assert.equal(result?.signature, f.sidecar.signature);
    assert.equal('publicKey' in result!, false);
    await assert.rejects(readArtifactSignature(f.asset, '1.0.1', f.metadata, required));
    await assert.rejects(readArtifactSignature({ ...f.asset, architecture: 'universal' }, '1.0.0', f.metadata, required));
    await assert.rejects(readArtifactSignature(f.asset, '1.0.0', { ...f.metadata, size: 4 }, required));
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test('invalid signature and missing required sidecar are rejected', async () => {
  const f = await fixture();
  try {
    await writeFile(`${f.asset.filePath}.sig.json`, JSON.stringify({ ...f.sidecar, signature: Buffer.alloc(64).toString('base64') }));
    await assert.rejects(readArtifactSignature(f.asset, '1.0.0', f.metadata, required));
    await rm(`${f.asset.filePath}.sig.json`);
    await assert.rejects(readArtifactSignature(f.asset, '1.0.0', f.metadata, required));
    assert.equal(await readArtifactSignature(f.asset, '1.0.0', f.metadata, optional), undefined);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test('application identity is configured per product, including optional signatures', async () => {
  const f = await fixture();
  try {
    await assert.rejects(readArtifactSignature(f.asset, '1.0.0', f.metadata,
      { ...required, signatureAppId: 'com.example.other' }), /不匹配/);
    await assert.rejects(readArtifactSignature(f.asset, '1.0.0', f.metadata,
      { signaturePolicy: 'optional', signatureAppId: 'com.example.other' }), /不匹配/);
    assert.equal((await readArtifactSignature(f.asset, '1.0.0', f.metadata, optional))?.signature, f.sidecar.signature);
    await writeFile(`${f.asset.filePath}.sig.json`, JSON.stringify({ ...f.sidecar, signature: Buffer.alloc(64).toString('base64') }));
    await assert.rejects(readArtifactSignature(f.asset, '1.0.0', f.metadata, optional), /签名验证失败/);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test('unconfigured policies and required signatures without an application ID are rejected', () => {
  assert.throws(() => normalizeSignatureSettings({ signaturePolicy: null }), /选择更新包签名策略/);
  assert.throws(() => normalizeSignatureSettings({ signaturePolicy: 'disabled' }), /选择更新包签名策略/);
  assert.throws(() => normalizeSignatureSettings({ ...required, signatureAppId: ' ' }), /填写应用标识/);
  assert.throws(() => normalizeSignatureSettings({ ...optional, signatureAppId: 'bad id' }), /应用标识/);
  assert.deepEqual(normalizeSignatureSettings({ ...required, signatureAppId: ' com.example.desktop ' }), required);
});
