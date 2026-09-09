import { Buffer } from 'node:buffer';

import type {
  CreateProductInput,
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
  ): Promise<void> {
    const body: Record<string, string> = {
      message: 'chore: initialize ReleaseHub management',
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
