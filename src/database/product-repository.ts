import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { normalizeSignatureSettings } from '../shared/signature-policy';
import { normalizeRepositoryUrl, repositoryProviders } from '../shared/repository-provider';

import type {
  AppSettings,
  CreateProductInput,
  Product,
  ProductRelease,
  ProviderConnection,
  RepositoryProvider,
  UpdateProductInput,
  VerifiedConnection,
} from '../shared/product';

type ProductRow = Product;

interface MigrationRow {
  version: number;
}

interface SettingRow {
  value: string;
}

interface ConnectionRow {
  provider: RepositoryProvider;
  accountLogin: string;
  verifiedAt: number;
}

interface TokenRow {
  encryptedToken: Uint8Array;
}

const migrations = [
  {
    version: 1,
    name: '创建产品表',
    sql: `
      CREATE TABLE products (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL COLLATE NOCASE UNIQUE,
        description TEXT NOT NULL DEFAULT '',
        repository_provider TEXT NOT NULL
          CHECK (repository_provider IN ('github', 'gitee')),
        repository_url TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (repository_provider, repository_url)
      );
    `,
  },
  {
    version: 2,
    name: '创建应用设置与代码托管连接表',
    sql: `
      CREATE TABLE app_settings (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      INSERT INTO app_settings (key, value, updated_at)
      VALUES ('default_branch', 'main', unixepoch() * 1000);

      CREATE TABLE provider_connections (
        provider TEXT PRIMARY KEY NOT NULL
          CHECK (provider IN ('github', 'gitee')),
        encrypted_token BLOB NOT NULL,
        account_login TEXT NOT NULL,
        verified_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `,
  },
  {
    version: 3,
    name: '记录已同步的当前版本',
    sql: `
      ALTER TABLE products ADD COLUMN current_version TEXT;
    `,
  },
  {
    version: 4,
    name: '记录发布版本与构建产物',
    sql: `
      CREATE TABLE releases (
        id TEXT PRIMARY KEY NOT NULL,
        product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        version TEXT NOT NULL,
        notes TEXT NOT NULL DEFAULT '',
        channel TEXT NOT NULL DEFAULT 'stable',
        published_at INTEGER NOT NULL,
        UNIQUE(product_id, version, channel)
      );
      CREATE TABLE release_assets (
        id TEXT PRIMARY KEY NOT NULL,
        release_id TEXT NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
        file_name TEXT NOT NULL,
        platform TEXT NOT NULL,
        architecture TEXT NOT NULL,
        package_type TEXT NOT NULL,
        size INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        download_url TEXT NOT NULL
      );
    `,
  },
  {
    version: 5,
    name: '记录新产品指定的发布分支',
    sql: `
      ALTER TABLE products ADD COLUMN release_branch TEXT;
    `,
  },
  {
    version: 6,
    name: '保留构建产物发布签名',
    sql: 'ALTER TABLE release_assets ADD COLUMN update_signature TEXT;',
  },
  {
    version: 7,
    name: '添加产品级更新包签名策略',
    sql: `
      ALTER TABLE products ADD COLUMN signature_policy TEXT
        CHECK (signature_policy IN ('optional', 'required'));
      ALTER TABLE products ADD COLUMN signature_app_id TEXT;
    `,
  },
  {
    version: 8,
    name: '添加 CNB 托管平台并保留现有产品和连接',
    sql: `
      CREATE TABLE products_new (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL COLLATE NOCASE UNIQUE,
        description TEXT NOT NULL DEFAULT '',
        repository_provider TEXT NOT NULL CHECK (repository_provider IN ('github', 'gitee', 'cnb')),
        repository_url TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        current_version TEXT,
        release_branch TEXT,
        signature_policy TEXT CHECK (signature_policy IN ('optional', 'required')),
        signature_app_id TEXT,
        UNIQUE (repository_provider, repository_url)
      );
      INSERT INTO products_new SELECT id, name, description, repository_provider, repository_url,
        created_at, updated_at, current_version, release_branch, signature_policy, signature_app_id FROM products;
      DROP TABLE products;
      ALTER TABLE products_new RENAME TO products;
      CREATE TABLE provider_connections_new (
        provider TEXT PRIMARY KEY NOT NULL CHECK (provider IN ('github', 'gitee', 'cnb')),
        encrypted_token BLOB NOT NULL,
        account_login TEXT NOT NULL,
        verified_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO provider_connections_new (provider, encrypted_token, account_login, verified_at, updated_at)
        SELECT provider, encrypted_token, account_login, verified_at, updated_at FROM provider_connections;
      DROP TABLE provider_connections;
      ALTER TABLE provider_connections_new RENAME TO provider_connections;
    `,
  },
];

export class ProductRepository {
  private readonly database: DatabaseSync;

  constructor(databasePath: string) {
    mkdirSync(path.dirname(databasePath), { recursive: true });
    this.database = new DatabaseSync(databasePath, { timeout: 5000 });
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
    `);
    this.applyMigrations();
  }

  list(): Product[] {
    const statement = this.database.prepare(`
      SELECT
        id,
        name,
        description,
        repository_provider AS repositoryProvider,
        repository_url AS repositoryUrl,
        current_version AS currentVersion,
        release_branch AS releaseBranch,
        signature_policy AS signaturePolicy,
        signature_app_id AS signatureAppId,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM products
      ORDER BY created_at DESC
    `);
    const rows = statement.all() as unknown as ProductRow[];

    return rows.map((row) => ({
      ...row,
    }));
  }

  create(
    input: CreateProductInput,
    currentVersion: string | null,
    releaseBranch: string,
  ): Product {
    const product = this.normalizeProductInput(input);
    const now = Date.now();
    const statement = this.database.prepare(`
      INSERT INTO products (
        id,
        name,
        description,
        repository_provider,
        repository_url,
        current_version,
        release_branch,
        signature_policy,
        signature_app_id,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    statement.run(
      product.id,
      product.name,
      product.description,
      product.repositoryProvider,
      product.repositoryUrl,
      currentVersion,
      releaseBranch,
      product.signaturePolicy,
      product.signatureAppId,
      now,
      now,
    );

    return {
      ...product,
      currentVersion,
      releaseBranch,
      createdAt: now,
      updatedAt: now,
    };
  }

  update(input: UpdateProductInput): Product {
    const id = input?.id?.trim();
    const name = input?.name?.trim();
    const description = input?.description?.trim() || '';

    if (!id) {
      throw new Error('产品标识不正确');
    }
    if (!name) {
      throw new Error('请输入产品名称');
    }
    if (name.length > 100) {
      throw new Error('产品名称不能超过 100 个字符');
    }
    if (description.length > 2000) {
      throw new Error('产品描述不能超过 2000 个字符');
    }

    const nameStatement = this.database.prepare(
      'SELECT id FROM products WHERE name = ? COLLATE NOCASE AND id != ?',
    );
    if (nameStatement.get(name, id)) {
      throw new Error('产品名称已存在');
    }

    const signatureSettings = normalizeSignatureSettings(input);
    const now = Date.now();
    const updateStatement = this.database.prepare(`
      UPDATE products
      SET name = ?, description = ?, signature_policy = ?, signature_app_id = ?, updated_at = ?
      WHERE id = ?
    `);
    const result = updateStatement.run(name, description, signatureSettings.signaturePolicy, signatureSettings.signatureAppId, now, id);
    if (Number(result.changes) === 0) {
      throw new Error('产品不存在或已被删除');
    }

    const productStatement = this.database.prepare(`
      SELECT
        id,
        name,
        description,
        repository_provider AS repositoryProvider,
        repository_url AS repositoryUrl,
        current_version AS currentVersion,
        release_branch AS releaseBranch,
        signature_policy AS signaturePolicy,
        signature_app_id AS signatureAppId,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM products
      WHERE id = ?
    `);
    return productStatement.get(id) as unknown as Product;
  }

  delete(id: string): void {
    const productId = id?.trim();
    if (!productId) {
      throw new Error('产品标识不正确');
    }

    const result = this.database.prepare('DELETE FROM products WHERE id = ?').run(productId);
    if (Number(result.changes) === 0) {
      throw new Error('产品不存在或已被删除');
    }
  }

  getById(id: string): Product {
    const statement = this.database.prepare(`
      SELECT id, name, description, repository_provider AS repositoryProvider,
        repository_url AS repositoryUrl, current_version AS currentVersion,
        release_branch AS releaseBranch,
        signature_policy AS signaturePolicy,
        signature_app_id AS signatureAppId,
        created_at AS createdAt, updated_at AS updatedAt
      FROM products WHERE id = ?
    `);
    const product = statement.get(id) as unknown as Product | undefined;
    if (!product) throw new Error('产品不存在或已被删除');
    return product;
  }

  listReleases(productId: string): ProductRelease[] {
    const releases = this.database.prepare(`
      SELECT id, product_id AS productId, version, notes, channel, published_at AS publishedAt
      FROM releases WHERE product_id = ? ORDER BY published_at DESC
    `).all(productId) as unknown as ProductRelease[];
    const assets = this.database.prepare(`
      SELECT id, file_name AS fileName, platform, architecture,
        package_type AS packageType, size, sha256, download_url AS downloadUrl,
        update_signature AS updateSignatureJson
      FROM release_assets WHERE release_id = ?
    `);
    return releases.map((release) => ({ ...release, assets: assets.all(release.id).map((row) => {
      const { updateSignatureJson, ...asset } = row;
      return { ...asset, ...(typeof updateSignatureJson === 'string'
        ? { updateSignature: JSON.parse(updateSignatureJson) } : {}) };
    }) as unknown as ProductRelease['assets'] }));
  }

  saveRelease(release: ProductRelease, overwrite = false): void {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      if (overwrite) {
        // 外键级联删除旧附件；与新版本及附件的写入一起提交或回滚。
        this.database.prepare('DELETE FROM releases WHERE product_id = ? AND version = ? AND channel = ?')
          .run(release.productId, release.version, release.channel);
      }
      this.database.prepare(`INSERT INTO releases (id, product_id, version, notes, channel, published_at)
        VALUES (?, ?, ?, ?, ?, ?)`)
        .run(release.id, release.productId, release.version, release.notes, release.channel, release.publishedAt);
      const assetStatement = this.database.prepare(`INSERT INTO release_assets
        (id, release_id, file_name, platform, architecture, package_type, size, sha256, download_url, update_signature)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const asset of release.assets) {
        assetStatement.run(asset.id, release.id, asset.fileName, asset.platform, asset.architecture, asset.packageType, asset.size, asset.sha256, asset.downloadUrl,
          asset.updateSignature ? JSON.stringify(asset.updateSignature) : null);
      }
      this.database.prepare('UPDATE products SET current_version = ?, updated_at = ? WHERE id = ?')
        .run(release.version, Date.now(), release.productId);
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  getSettings(): AppSettings {
    const branchStatement = this.database.prepare(
      "SELECT value FROM app_settings WHERE key = 'default_branch'",
    );
    const connectionStatement = this.database.prepare(`
      SELECT
        provider,
        account_login AS accountLogin,
        verified_at AS verifiedAt
      FROM provider_connections
    `);
    const branchRow = branchStatement.get() as unknown as SettingRow | undefined;
    const connectionRows = connectionStatement.all() as unknown as ConnectionRow[];
    const connectionByProvider = new Map(
      connectionRows.map((connection) => [connection.provider, connection]),
    );
    const connections: ProviderConnection[] = repositoryProviders.map(
      (provider) => {
        const connection = connectionByProvider.get(provider as RepositoryProvider);
        return {
          provider: provider as RepositoryProvider,
          configured: Boolean(connection),
          accountLogin: connection?.accountLogin || null,
          verifiedAt: connection?.verifiedAt || null,
          token: null,
        };
      },
    );

    return {
      defaultBranch: branchRow?.value || 'main',
      connections,
    };
  }

  updateDefaultBranch(defaultBranch: string): void {
    const statement = this.database.prepare(`
      INSERT INTO app_settings (key, value, updated_at)
      VALUES ('default_branch', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `);
    statement.run(defaultBranch, Date.now());
  }

  saveVerifiedConnection(
    connection: VerifiedConnection,
    encryptedToken: Uint8Array,
  ): void {
    const statement = this.database.prepare(`
      INSERT INTO provider_connections (
        provider,
        encrypted_token,
        account_login,
        verified_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(provider) DO UPDATE SET
        encrypted_token = excluded.encrypted_token,
        account_login = excluded.account_login,
        verified_at = excluded.verified_at,
        updated_at = excluded.updated_at
    `);
    statement.run(
      connection.provider,
      encryptedToken,
      connection.accountLogin,
      connection.verifiedAt,
      Date.now(),
    );
  }

  hasVerifiedConnection(provider: RepositoryProvider): boolean {
    const statement = this.database.prepare(
      'SELECT provider FROM provider_connections WHERE provider = ?',
    );
    return Boolean(statement.get(provider));
  }

  getEncryptedToken(provider: RepositoryProvider): Uint8Array {
    const statement = this.database.prepare(
      'SELECT encrypted_token AS encryptedToken FROM provider_connections WHERE provider = ?',
    );
    const row = statement.get(provider) as unknown as TokenRow | undefined;

    if (!row?.encryptedToken) {
      throw new Error('请先在设置中验证对应平台的 Token');
    }

    return row.encryptedToken;
  }

  normalizeCreateInput(input: CreateProductInput): CreateProductInput {
    const product = this.normalizeProductInput(input);
    return {
      name: product.name,
      description: product.description,
      repositoryProvider: product.repositoryProvider,
      repositoryUrl: product.repositoryUrl,
      signaturePolicy: product.signaturePolicy,
      signatureAppId: product.signatureAppId,
    };
  }

  assertCanCreate(input: CreateProductInput): void {
    const product = this.normalizeCreateInput(input);
    const statement = this.database.prepare(`
      SELECT name, repository_provider AS repositoryProvider, repository_url AS repositoryUrl
      FROM products
      WHERE name = ? COLLATE NOCASE
         OR (repository_provider = ? AND repository_url = ?)
      LIMIT 1
    `);
    const existing = statement.get(
      product.name,
      product.repositoryProvider,
      product.repositoryUrl,
    ) as
      | { name: string; repositoryProvider: RepositoryProvider; repositoryUrl: string }
      | undefined;

    if (!existing) {
      return;
    }

    if (existing.name.toLocaleLowerCase() === product.name.toLocaleLowerCase()) {
      throw new Error('产品名称已存在');
    }

    throw new Error('该仓库已被其他产品使用');
  }

  close(): void {
    this.database.close();
  }

  private applyMigrations(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        executed_at INTEGER NOT NULL
      );
    `);

    const getAppliedMigration = this.database.prepare(
      'SELECT version FROM schema_migrations WHERE version = ?',
    );
    const addMigration = this.database.prepare(`
      INSERT INTO schema_migrations (version, name, executed_at)
      VALUES (?, ?, ?)
    `);

    for (const migration of migrations) {
      const appliedMigration = getAppliedMigration.get(
        migration.version,
      ) as unknown as MigrationRow | undefined;

      if (appliedMigration) {
        continue;
      }

      // SQLite 更改 CHECK 约束需重建表；关闭级联删除，保留 releases/附件外键。
      if (migration.version === 8) this.database.exec('PRAGMA foreign_keys = OFF');
      let transactionStarted = false;
      try {
        this.database.exec('BEGIN IMMEDIATE');
        transactionStarted = true;
        this.database.exec(migration.sql);
        if (this.database.prepare('PRAGMA foreign_key_check').all().length) {
          throw new Error('数据库迁移外键校验失败，已取消迁移');
        }
        addMigration.run(migration.version, migration.name, Date.now());
        this.database.exec('COMMIT');
      } catch (error) {
        if (transactionStarted) this.database.exec('ROLLBACK');
        throw error;
      } finally { this.database.exec('PRAGMA foreign_keys = ON'); }
    }
  }

  private normalizeProductInput(input: CreateProductInput): Omit<Product, 'currentVersion' | 'createdAt' | 'updatedAt' | 'releaseBranch'> {
    if (!input || typeof input !== 'object') {
      throw new Error('产品数据格式不正确');
    }

    const name = input.name?.trim();
    const description = input.description?.trim() || '';

    if (!name) {
      throw new Error('请输入产品名称');
    }

    if (name.length > 100) {
      throw new Error('产品名称不能超过 100 个字符');
    }

    if (description.length > 2000) {
      throw new Error('产品描述不能超过 2000 个字符');
    }

    const repositoryProvider = input.repositoryProvider;
    if (!repositoryProviders.includes(repositoryProvider)) {
      throw new Error('请选择 GitHub、Gitee 或 CNB');
    }

    return {
      id: randomUUID(),
      ...normalizeSignatureSettings(input),
      name,
      description,
      repositoryProvider,
      repositoryUrl: normalizeRepositoryUrl(
        input.repositoryUrl,
        repositoryProvider,
      ),
    };
  }

}
