import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { ProductRepository } from './product-repository';
import { normalizeSignatureSettings } from '../shared/signature-policy';
import type { CreateProductInput, ProductRelease } from '../shared/product';

const input: CreateProductInput = {
  name: 'Example', repositoryProvider: 'github', repositoryUrl: 'https://github.com/example/desktop',
  signaturePolicy: 'required', signatureAppId: 'com.example.desktop',
};

test('product signature settings survive normalization, edits and reopening independently', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'release-hub-products-'));
  const databasePath = path.join(directory, 'test.sqlite');
  let repository = new ProductRepository(databasePath);
  try {
    const first = repository.create(repository.normalizeCreateInput(input), null, 'releases');
    const second = repository.create({ ...input, name: 'Other', repositoryProvider: 'gitee',
      repositoryUrl: 'https://gitee.com/example/other', signaturePolicy: 'optional', signatureAppId: null }, null, 'main');
    assert.equal(repository.getById(first.id).signatureAppId, input.signatureAppId);
    assert.throws(() => repository.update({ id: first.id, name: first.name,
      signaturePolicy: 'required', signatureAppId: '' }), /填写应用标识/);
    repository.update({ id: first.id, name: first.name, signaturePolicy: 'required', signatureAppId: 'com.example.new' });
    repository.close();
    repository = new ProductRepository(databasePath);
    const products = repository.list();
    assert.equal(products.find((product) => product.id === first.id)?.signatureAppId, 'com.example.new');
    assert.equal(repository.getById(first.id).releaseBranch, 'releases');
    assert.equal(repository.getById(second.id).signaturePolicy, 'optional');
    assert.equal(repository.getById(second.id).signatureAppId, null);
  } finally {
    repository.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('version 6 products require policy selection while keeping branch and release history', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'release-hub-migration-'));
  const databasePath = path.join(directory, 'test.sqlite');
  let repository = new ProductRepository(databasePath);
  try {
    const product = repository.create(input, null, 'releases');
    const release: ProductRelease = { id: 'release-1', productId: product.id, version: '1.0.0',
      channel: 'stable', notes: 'Existing release', publishedAt: 1,
      assets: [{ id: 'asset-1', fileName: 'Example.zip', platform: 'macos', architecture: 'arm64',
        packageType: 'zip', size: 3, sha256: 'a'.repeat(64), downloadUrl: 'https://example.com/Example.zip',
        updateSignature: { algorithm: 'ed25519', keyId: 'historical-key', payload: 'historical-payload', signature: 'historical-signature' } }] };
    repository.saveRelease(release);
    repository.close();
    // Restore the schema shape of migration 6 in this disposable database only.
    const legacy = new DatabaseSync(databasePath);
    try {
      legacy.exec(`ALTER TABLE products DROP COLUMN signature_policy;
        ALTER TABLE products DROP COLUMN signature_app_id;
        DELETE FROM schema_migrations WHERE version = 7;`);
    } finally { legacy.close(); }
    repository = new ProductRepository(databasePath);
    const migrated = repository.getById(product.id);
    assert.equal(migrated.signaturePolicy, null);
    assert.equal(migrated.signatureAppId, null);
    assert.equal(migrated.releaseBranch, 'releases');
    assert.equal(migrated.currentVersion, '1.0.0');
    assert.throws(() => normalizeSignatureSettings(migrated), /选择更新包签名策略/);
    assert.deepEqual(repository.listReleases(product.id), [release]);
    repository.update({ id: product.id, name: product.name, signaturePolicy: 'required', signatureAppId: input.signatureAppId });
    assert.equal(normalizeSignatureSettings(repository.getById(product.id)).signaturePolicy, 'required');
  } finally {
    repository.close();
    await rm(directory, { recursive: true, force: true });
  }
});
