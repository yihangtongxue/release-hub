import { Buffer } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';

import type {
  CreateProductInput,
  Product,
  ProductRelease,
  PublishReleaseInput,
  RepositoryInspection,
  RepositoryProvider,
} from '../shared/product';

const managedManifestPath = '.release-hub/manifest.json';
const latestReleasePath = '.release-hub/updates/stable.json';
const requestTimeoutMs = 15_000;

interface RepositoryReference {
  owner: string;
  name: string;
}

interface RemoteFile {
  content: string;
  sha?: string;
}

interface Manifest {
  schemaVersion?: unknown;
  managedBy?: unknown;
}

interface LatestRelease {
  version?: unknown;
}

const providerLabel = (provider: RepositoryProvider): string =>
  provider === 'github' ? 'GitHub' : 'Gitee';

const parseRepositoryReference = (input: CreateProductInput): RepositoryReference => {
  const url = new URL(input.repositoryUrl);
  const [owner, name] = url.pathname.split('/').filter(Boolean);

  if (!owner || !name) {
    throw new Error('仓库地址格式不正确');
  }

  return { owner, name: name.replace(/\.git$/, '') };
};

const decodeJsonFile = <T>(file: RemoteFile): T => {
  try {
    return JSON.parse(Buffer.from(file.content.replace(/\n/g, ''), 'base64').toString('utf8')) as T;
  } catch {
    throw new Error('ReleaseHub 管理文件内容不是有效的 JSON');
  }
};

const buildManifest = (product: CreateProductInput): string =>
  `${JSON.stringify(
    {
      schemaVersion: 1,
      managedBy: 'ReleaseHub',
      product: { name: product.name },
      release: { tagPrefix: 'v', defaultChannel: 'stable' },
      update: {
        latestManifestPath: latestReleasePath,
        checksumAlgorithm: 'sha256',
      },
    },
    null,
    2,
  )}\n`;

export class ReleaseHubRepositoryService {
  async publish(
    product: Product,
    input: PublishReleaseInput,
    token: string,
    configuredDefaultBranch: string,
  ): Promise<ProductRelease> {
    const version = input.version.trim();
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
      throw new Error('版本号应为 SemVer 格式，例如 1.2.0');
    }
    if (!input.assets.length) throw new Error('请至少添加一个构建产物');
    const createInput: CreateProductInput = { name: product.name, description: product.description, repositoryProvider: product.repositoryProvider, repositoryUrl: product.repositoryUrl };
    const inspection = await this.inspect(createInput, token, configuredDefaultBranch);
    if (inspection.state !== 'ready') throw new Error('仓库尚未完成 ReleaseHub 初始化');
    const reference = parseRepositoryReference(createInput);
    const tag = `v${version}`;
    const release = await this.createRelease(product.repositoryProvider, reference, tag, input.notes?.trim() || '', inspection.defaultBranch, token);
    const assets = [] as ProductRelease['assets'];
    for (const asset of input.assets) {
      const metadata = await this.readAsset(asset.filePath, asset.fileName);
      const downloadUrl = await this.uploadAsset(product.repositoryProvider, reference, release, metadata, token);
      assets.push({ id: randomUUID(), fileName: metadata.fileName, platform: asset.platform, architecture: asset.architecture, packageType: asset.packageType, size: metadata.size, sha256: metadata.sha256, downloadUrl });
    }
    const result: ProductRelease = { id: randomUUID(), productId: product.id, version, notes: input.notes?.trim() || '', channel: 'stable', publishedAt: Date.now(), assets };
    const existing = await this.getFile(product.repositoryProvider, reference, latestReleasePath, inspection.defaultBranch, token);
    await this.putFile(product.repositoryProvider, reference, latestReleasePath, `${JSON.stringify({ version, tag, publishedAt: result.publishedAt, notes: result.notes, assets }, null, 2)}\n`, inspection.defaultBranch, existing?.sha, token, `chore: publish ${tag}`);
    return result;
  }
  async inspect(
    product: CreateProductInput,
    token: string,
    configuredDefaultBranch: string,
  ): Promise<RepositoryInspection> {
    const reference = parseRepositoryReference(product);
    const repository = await this.getRepository(product.repositoryProvider, reference, token);
    const branch = this.getDefaultBranch(repository, configuredDefaultBranch);
    const manifestFile = await this.getFile(
      product.repositoryProvider,
      reference,
      managedManifestPath,
      branch,
      token,
    );

    if (!manifestFile) {
      const isEmpty = repository.size === 0 || repository.empty_repo === true;
      return {
        state: 'needs-initialization',
        reason: isEmpty ? 'empty' : 'missing-manifest',
        defaultBranch: branch,
        currentVersion: null,
        message: isEmpty
          ? '这是一个空仓库，需要初始化 ReleaseHub 管理文件。'
          : '仓库未包含 ReleaseHub 管理文件，需要确认初始化。',
      };
    }

    let manifest: Manifest;
    try {
      manifest = decodeJsonFile<Manifest>(manifestFile);
    } catch {
      return {
        state: 'needs-initialization',
        reason: 'invalid-manifest',
        defaultBranch: branch,
        currentVersion: null,
        message: '仓库中的 ReleaseHub 管理文件无法读取，需要确认覆盖。',
      };
    }
    if (manifest.schemaVersion !== 1 || manifest.managedBy !== 'ReleaseHub') {
      return {
        state: 'needs-initialization',
        reason: 'invalid-manifest',
        defaultBranch: branch,
        currentVersion: null,
        message: '仓库中的 ReleaseHub 管理文件不兼容，需要确认覆盖。',
      };
    }

    const latestRelease = await this.getFile(
      product.repositoryProvider,
      reference,
      latestReleasePath,
      branch,
      token,
    );
    let currentVersion: string | null = null;
    if (latestRelease) {
      try {
        currentVersion = this.readVersion(latestRelease);
      } catch {
        // 更新清单不影响仓库管理资格；首个版本发布时会重新写入该文件。
        currentVersion = null;
      }
    }

    return {
      state: 'ready',
      reason: 'managed',
      defaultBranch: branch,
      currentVersion,
      message: currentVersion
        ? `仓库已由 ReleaseHub 管理，当前版本为 ${currentVersion}。`
        : '仓库已由 ReleaseHub 管理，尚未发布版本。',
    };
  }

  async initialize(
    product: CreateProductInput,
    token: string,
    configuredDefaultBranch: string,
  ): Promise<RepositoryInspection> {
    const before = await this.inspect(product, token, configuredDefaultBranch);
    if (before.state === 'ready') {
      return before;
    }

    const reference = parseRepositoryReference(product);
    const currentFile = await this.getFile(
      product.repositoryProvider,
      reference,
      managedManifestPath,
      before.defaultBranch,
      token,
    );
    await this.putFile(
      product.repositoryProvider,
      reference,
      managedManifestPath,
      buildManifest(product),
      before.defaultBranch,
      currentFile?.sha,
      token,
    );

    return this.inspect(product, token, configuredDefaultBranch);
  }

  private async getRepository(
    provider: RepositoryProvider,
    reference: RepositoryReference,
    token: string,
  ): Promise<{ default_branch?: unknown; size?: unknown; empty_repo?: unknown }> {
    const response = await this.request(
      provider,
      `/repos/${encodeURIComponent(reference.owner)}/${encodeURIComponent(reference.name)}`,
      token,
    );
    if (!response.ok) {
      throw await this.remoteError(provider, response, '读取仓库失败');
    }

    return (await response.json()) as {
      default_branch?: unknown;
      size?: unknown;
      empty_repo?: unknown;
    };
  }

  private async getFile(
    provider: RepositoryProvider,
    reference: RepositoryReference,
    filePath: string,
    branch: string,
    token: string,
  ): Promise<RemoteFile | null> {
    const response = await this.request(
      provider,
      `/repos/${encodeURIComponent(reference.owner)}/${encodeURIComponent(reference.name)}/contents/${filePath}?ref=${encodeURIComponent(branch)}`,
      token,
    );
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw await this.remoteError(provider, response, `读取 ${filePath} 失败`);
    }

    return (await response.json()) as RemoteFile;
  }

  private async putFile(
    provider: RepositoryProvider,
    reference: RepositoryReference,
    filePath: string,
    content: string,
    branch: string,
    sha: string | undefined,
    token: string,
    message = 'chore: initialize ReleaseHub management',
  ): Promise<void> {
    const body: Record<string, string> = {
      message,
      content: Buffer.from(content).toString('base64'),
      branch,
    };
    if (sha) {
      body.sha = sha;
    }

    const response = await this.request(
      provider,
      `/repos/${encodeURIComponent(reference.owner)}/${encodeURIComponent(reference.name)}/contents/${filePath}`,
      token,
      {
        // Gitee distinguishes creating a file (POST) from updating one (PUT).
        // GitHub uses PUT for both operations.
        method: provider === 'gitee' && !sha ? 'POST' : 'PUT',
        body: JSON.stringify(body),
      },
    );
    if (!response.ok) {
      throw await this.remoteError(
        provider,
        response,
        '初始化 ReleaseHub 管理文件失败',
      );
    }
  }

  private async readAsset(filePath: string, expectedName: string) {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error(`${expectedName} 不是有效文件`);
    const content = await readFile(filePath);
    return { fileName: expectedName, content, size: info.size, sha256: createHash('sha256').update(content).digest('hex') };
  }

  private async createRelease(provider: RepositoryProvider, reference: RepositoryReference, tag: string, notes: string, branch: string, token: string): Promise<{ id: number; uploadUrl?: string }> {
    const response = await this.request(provider, `/repos/${encodeURIComponent(reference.owner)}/${encodeURIComponent(reference.name)}/releases`, token, { method: 'POST', body: JSON.stringify({ tag_name: tag, target_commitish: branch, name: tag, body: notes }) });
    if (!response.ok) throw await this.remoteError(provider, response, '创建 Release 失败');
    const body = await response.json() as { id?: unknown; upload_url?: unknown };
    if (typeof body.id !== 'number') throw new Error('平台未返回 Release 标识');
    return { id: body.id, uploadUrl: typeof body.upload_url === 'string' ? body.upload_url : undefined };
  }

  private async uploadAsset(provider: RepositoryProvider, reference: RepositoryReference, release: { id: number; uploadUrl?: string }, asset: { fileName: string; content: Buffer }, token: string): Promise<string> {
    if (provider === 'github') {
      const uploadUrl = release.uploadUrl?.replace('{?name,label}', `?name=${encodeURIComponent(asset.fileName)}`);
      if (!uploadUrl) throw new Error('GitHub 未返回附件上传地址');
      const response = await fetch(uploadUrl, { method: 'POST', headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream', 'X-GitHub-Api-Version': '2022-11-28' }, body: asset.content, signal: AbortSignal.timeout(120_000) });
      if (!response.ok) throw await this.remoteError(provider, response, `上传 ${asset.fileName} 失败`);
      const body = await response.json() as { browser_download_url?: unknown };
      if (typeof body.browser_download_url !== 'string') throw new Error('GitHub 未返回附件下载地址');
      return body.browser_download_url;
    }
    const form = new FormData();
    form.append('file', new Blob([asset.content]), asset.fileName);
    const response = await fetch(`https://gitee.com/api/v5/repos/${encodeURIComponent(reference.owner)}/${encodeURIComponent(reference.name)}/releases/${release.id}/attach_files?access_token=${encodeURIComponent(token)}`, { method: 'POST', body: form, signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw await this.remoteError(provider, response, `上传 ${asset.fileName} 失败`);
    const body = await response.json() as { browser_download_url?: unknown; download_url?: unknown };
    const downloadUrl = body.browser_download_url ?? body.download_url;
    if (typeof downloadUrl !== 'string') throw new Error('Gitee 未返回附件下载地址');
    return downloadUrl;
  }

  private async request(
    provider: RepositoryProvider,
    resource: string,
    token: string,
    init: RequestInit = {},
  ): Promise<Response> {
    const isGitHub = provider === 'github';
    const baseUrl = isGitHub ? 'https://api.github.com' : 'https://gitee.com/api/v5';
    const separator = resource.includes('?') ? '&' : '?';
    const resourceWithToken = isGitHub
      ? resource
      : `${resource}${separator}access_token=${encodeURIComponent(token)}`;
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json, application/json',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(isGitHub
        ? {
            Authorization: `Bearer ${token}`,
            'X-GitHub-Api-Version': '2022-11-28',
          }
        : {}),
    };

    return fetch(`${baseUrl}${resourceWithToken}`, {
      ...init,
      headers,
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
  }

  private getDefaultBranch(
    repository: { default_branch?: unknown },
    configuredDefaultBranch: string,
  ): string {
    return typeof repository.default_branch === 'string' && repository.default_branch
      ? repository.default_branch
      : configuredDefaultBranch;
  }

  private readVersion(file: RemoteFile): string | null {
    const latestRelease = decodeJsonFile<LatestRelease>(file);
    return typeof latestRelease.version === 'string' && latestRelease.version.trim()
      ? latestRelease.version.trim()
      : null;
  }

  private async remoteError(
    provider: RepositoryProvider,
    response: Response,
    action: string,
  ): Promise<Error> {
    const detail = await this.readRemoteErrorDetail(response);
    const suffix = detail ? `：${detail}` : '';
    const { status } = response;
    if (status === 401) {
      return new Error(`${providerLabel(provider)} Token 无效或已过期`);
    }
    if (status === 403) {
      return new Error(`${action}：Token 没有仓库访问权限${suffix}`);
    }
    if (status === 404) {
      return new Error(`${action}：仓库不存在，或 Token 无权访问`);
    }
    return new Error(`${action}${suffix}`);
  }

  private async readRemoteErrorDetail(response: Response): Promise<string | null> {
    try {
      const body = (await response.json()) as {
        message?: unknown;
        error?: unknown;
        error_description?: unknown;
      };
      const detail = body.message ?? body.error_description ?? body.error;
      return typeof detail === 'string' && detail.trim() ? detail.trim() : null;
    } catch {
      return null;
    }
  }
}
