import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type {
  CreateProductInput,
  Product,
  RepositoryProvider,
} from '../shared/product';

interface ProductRow {
  id: string;
  name: string;
  description: string;
  repositoryProvider: RepositoryProvider;
  repositoryUrl: string;
  createdAt: number;
  updatedAt: number;
}

interface MigrationRow {
  version: number;
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
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM products
      ORDER BY created_at DESC
    `);
    const rows = statement.all() as unknown as ProductRow[];

    return rows.map((row) => ({
      ...row,
      currentVersion: null,
    }));
  }

  create(input: CreateProductInput): Product {
    const product = this.normalizeProductInput(input);
    const now = Date.now();
    const statement = this.database.prepare(`
      INSERT INTO products (
        id,
        name,
        description,
        repository_provider,
        repository_url,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    statement.run(
      product.id,
      product.name,
      product.description,
      product.repositoryProvider,
      product.repositoryUrl,
      now,
      now,
    );

    return {
      ...product,
      currentVersion: null,
      createdAt: now,
      updatedAt: now,
    };
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

      this.database.exec('BEGIN IMMEDIATE');
      try {
        this.database.exec(migration.sql);
        addMigration.run(migration.version, migration.name, Date.now());
        this.database.exec('COMMIT');
      } catch (error) {
        this.database.exec('ROLLBACK');
        throw error;
      }
    }
  }

  private normalizeProductInput(input: CreateProductInput): Omit<Product, 'currentVersion' | 'createdAt' | 'updatedAt'> {
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
    if (repositoryProvider !== 'github' && repositoryProvider !== 'gitee') {
      throw new Error('请选择 GitHub 或 Gitee');
    }

    return {
      id: randomUUID(),
      name,
      description,
      repositoryProvider,
      repositoryUrl: this.normalizeRepositoryUrl(
        input.repositoryUrl,
        repositoryProvider,
      ),
    };
  }

  private normalizeRepositoryUrl(
    rawUrl: string,
    provider: RepositoryProvider,
  ): string {
    let url: URL;

    try {
      url = new URL(rawUrl.trim());
    } catch {
      throw new Error('请输入有效的仓库地址');
    }

    const expectedHost = provider === 'github' ? 'github.com' : 'gitee.com';
    const segments = url.pathname.split('/').filter(Boolean);

    if (
      url.protocol !== 'https:' ||
      url.hostname !== expectedHost ||
      segments.length !== 2
    ) {
      throw new Error(`请输入有效的 ${provider === 'github' ? 'GitHub' : 'Gitee'} 仓库地址`);
    }

    const [owner, repository] = segments;
    return `https://${expectedHost}/${owner}/${repository.replace(/\.git$/, '')}`;
  }
}
