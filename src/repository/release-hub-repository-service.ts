import { Buffer } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import { openAsBlob } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { compareVersions, stableVersion, targetKey, validatePublishInput, validateTarget } from '../shared/release-validation';

import type {
  CreateProductInput,
  Product,
  ProductRelease,
  PublishReleaseInput,
  RepositoryInspection,
  RepositoryProvider,
  PublicUpdate,
  VerifyDownloadInput,
  DownloadVerification,
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
    progress: (message: string) => void = () => undefined,
  ): Promise<ProductRelease> {
    let stage = '校验发布信息';
    let remoteState = '尚未创建远端 Release，已有版本未修改。';
    const report = (message: string) => { stage = message; progress(message); };
    try {
      report(stage);
      input = validatePublishInput(input);
      const { version } = input;
      const prepared = [] as Awaited<ReturnType<ReleaseHubRepositoryService['readAsset']>>[];
      for (const [index, asset] of input.assets.entries()) {
        report(`校验文件 ${index + 1}/${input.assets.length}：${asset.fileName}`);
        prepared.push(await this.readAsset(asset.filePath, asset.fileName));
      }
      report('检查仓库与版本冲突');
      const inspection = await this.inspect(product, token, configuredDefaultBranch);
      if (inspection.state !== 'ready') throw new Error('仓库尚未完成 ReleaseHub 初始化');
      const reference = parseRepositoryReference(product);
      const provider = product.repositoryProvider;
      const existing = await this.getFile(provider, reference, latestReleasePath, inspection.defaultBranch, token);
      this.assertNewer(version, existing);
      await this.assertRemoteVersionAvailable(provider, reference, version, token);
      const tag = `v${version}`;
      report('创建 Release');
      remoteState = `已请求创建 ${tag}，返回结果尚未确认。请到 ${product.repositoryUrl}/releases 核对 Release 和标签后再重试。`;
      const release = await this.createRelease(provider, reference, tag, input.notes || '', inspection.defaultBranch, token);
      remoteState = `远端 ${tag} 已创建，可能有部分附件；更新清单尚未修改。请到 ${product.repositoryUrl}/releases 处理未完成的 Release 和同名标签后再重试。`;
      const assets: ProductRelease['assets'] = [];
      for (const [index, asset] of input.assets.entries()) {
        report(`上传附件 ${index + 1}/${input.assets.length}：${asset.fileName}`);
        const metadata = prepared[index];
        const downloadUrl = await this.uploadAsset(provider, reference, release, metadata, token);
        this.validateDownloadUrl(downloadUrl);
        assets.push({ id: randomUUID(), fileName: metadata.fileName, platform: asset.platform, architecture: asset.architecture, packageType: asset.packageType, size: metadata.size, sha256: metadata.sha256, downloadUrl });
      }
      const result: ProductRelease = { id: randomUUID(), productId: product.id, version, notes: input.notes || '', channel: 'stable', publishedAt: Date.now(), assets };
      report('再次检查最新版');
      const current = await this.getFile(provider, reference, latestReleasePath, inspection.defaultBranch, token);
      this.assertNewer(version, current);
      if (current?.sha !== existing?.sha) throw new Error('更新清单已被其他发布修改，本次停止更新，请核对远端版本');
      report('更新客户端清单');
      remoteState = `远端 ${tag} 和全部附件已创建；更新清单写入结果未确认。请到 ${product.repositoryUrl}/releases 及仓库中的 stable.json 核对状态，勿直接重复发布。`;
      await this.putFile(provider, reference, latestReleasePath, `${JSON.stringify({ schemaVersion: 1, channel: 'stable', version, tag, publishedAt: result.publishedAt, notes: result.notes, assets }, null, 2)}\n`, inspection.defaultBranch, existing?.sha, token, `发布 ${tag} 更新清单`);
      return result;
    } catch (error) {
      const detail = error instanceof Error ? error.message : '未知错误';
      throw new Error(`${stage}失败：${detail}\n${remoteState}`);
    }
  }

  private assertNewer(version: string, file: RemoteFile | null): void {
    if (!file) return;
    const current = decodeJsonFile<LatestRelease>(file);
    if (!current || typeof current.version !== 'string') throw new Error('远端更新清单版本无效，请先修复清单');
    if (compareVersions(version, current.version) <= 0) throw new Error(`版本必须高于当前稳定版 ${current.version}，不能重复发布或降级`);
  }

  async getPublicUpdate(product: Product, defaultBranch: string): Promise<PublicUpdate> {
    const reference = parseRepositoryReference(product);
    // 有意不传 Token：模拟没有发布凭据的客户端。
    const repository = await this.getRepository(product.repositoryProvider, reference, '');
    const branch = this.getDefaultBranch(repository, defaultBranch);
    const file = await this.getFile(product.repositoryProvider, reference, latestReleasePath, branch, '');
    if (!file) throw new Error('客户端无法读取稳定版清单，请检查仓库公开状态和是否已发布版本');
    const update = decodeJsonFile<PublicUpdate>(file);
    if (!update || stableVersion(update.version) !== update.version || update.tag !== `v${update.version}` ||
        !Array.isArray(update.assets) || !update.assets.length || update.assets.length > 20) {
      throw new Error('远端更新清单格式不正确');
    }
    const targets = new Set<string>();
    for (const asset of update.assets) {
      validateTarget(asset);
      const key = targetKey(asset);
      if (targets.has(key)) throw new Error(`更新清单有重复目标：${key}`);
      targets.add(key);
      if (typeof asset.fileName !== 'string' || !asset.fileName.toLowerCase().endsWith(`.${asset.packageType}`) ||
          !Number.isSafeInteger(asset.size) || asset.size <= 0 || typeof asset.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(asset.sha256)) {
        throw new Error('更新清单缺少有效的文件名、大小或 SHA-256');
      }
      this.validateDownloadUrl(asset.downloadUrl);
    }
    return update;
  }

  async verifyDownload(product: Product, input: VerifyDownloadInput, defaultBranch: string, progress: (message: string) => void): Promise<DownloadVerification> {
    progress('匿名读取最新更新清单');
    validateTarget(input);
    const update = await this.getPublicUpdate(product, defaultBranch);
    if (update.version !== input.version) throw new Error('远端最新版本已变化，请重新打开下载校验');
    const asset = update.assets.find((item) => targetKey(item) === targetKey(input));
    if (!asset) throw new Error('最新清单没有与所选平台、架构、包类型匹配的文件');
    progress(`下载并校验：${asset.fileName}`);
    const signal = AbortSignal.timeout(10 * 60 * 1000);
    let url = asset.downloadUrl;
    let response: Response | undefined;
    for (let redirects = 0; redirects <= 5; redirects++) {
      this.validateDownloadUrl(url);
      response = await fetch(url, { signal, redirect: 'manual' });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location || redirects === 5) throw new Error('附件下载重定向异常');
      url = new URL(location, url).href;
    }
    if (!response?.ok || !response.body) throw new Error(`客户端下载失败（HTTP ${response?.status}），请检查附件是否允许匿名下载`);
    const reader = response.body.getReader();
    const hash = createHash('sha256');
    let size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > asset.size) throw new Error('下载文件大于清单记录，附件可能被替换或链接返回了错误页面');
        hash.update(chunk.value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    const sha256 = hash.digest('hex');
    if (size !== asset.size || sha256 !== asset.sha256.toLowerCase()) throw new Error('下载文件大小或 SHA-256 不匹配，不能用于更新');
    progress('下载校验通过');
    return { version: update.version, fileName: asset.fileName, size, sha256 };
  }

  private validateDownloadUrl(value: string): void {
    let url: URL;
    try { url = new URL(value); } catch { throw new Error('附件下载地址无效'); }
    if (url.protocol !== 'https:' || url.username || url.password ||
        /^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[)/i.test(url.hostname) ||
        url.hostname.endsWith('.local') || url.searchParams.has('access_token')) {
      throw new Error('附件必须使用公开的 HTTPS 下载地址，不能携带发布 Token');
    }
  }

  private async assertRemoteVersionAvailable(provider: RepositoryProvider, reference: RepositoryReference, version: string, token: string): Promise<void> {
    const root = `/repos/${encodeURIComponent(reference.owner)}/${encodeURIComponent(reference.name)}`;
    // 同时检查 Release（含可见草稿）和标签，防止复用失败发布留下的 tag。
    for (const resource of ['releases', 'tags']) {
      let complete = false;
      for (let page = 1; page <= 100; page++) {
        const response = await this.request(provider, `${root}/${resource}?per_page=100&page=${page}`, token);
        if (!response.ok) throw await this.remoteError(provider, response, '检查远端版本失败');
        const items = await response.json() as Array<{ tag_name?: string; name?: string }>;
        if (!Array.isArray(items)) throw new Error('平台返回的版本列表无效');
        for (const item of items) {
          const tag = resource === 'releases' ? item.tag_name : item.name;
          const candidate = tag?.replace(/^v/, '');
          if (!candidate || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(candidate)) continue;
          if (compareVersions(version, candidate) <= 0) throw new Error(`远端已有版本或标签 ${tag}，请使用更高版本；失败遗留版本需先在平台处理`);
        }
        if (items.length < 100) { complete = true; break; }
      }
      if (!complete) throw new Error('远端版本过多，本次未能完成冲突检查');
    }
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
    if (!manifest || manifest.schemaVersion !== 1 || manifest.managedBy !== 'ReleaseHub') {
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
        // 可以管理该仓库，但发布前会严格校验清单，不自动覆盖损坏的版本信息。
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
      throw await this.remoteError(provider, response, '读取仓库失败', !token);
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
      throw await this.remoteError(provider, response, `读取 ${filePath} 失败`, !token);
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
        `写入 ${filePath} 失败`,
      );
    }
  }

  private async readAsset(filePath: string, expectedName: string) {
    if (!path.isAbsolute(filePath) || path.basename(filePath) !== expectedName) throw new Error('文件名与所选文件不一致，请重新选择');
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error(`${expectedName} 不是有效文件`);
    if (!info.size) throw new Error(`${expectedName} 是空文件`);
    const content = await openAsBlob(filePath);
    const hash = createHash('sha256');
    const reader = content.stream().getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        hash.update(value);
      }
    } finally { reader.releaseLock(); }
    // 同一个文件 Blob 用于哈希和上传；文件变化时读取会失败，避免清单与附件不一致。
    return { fileName: expectedName, content, size: content.size, sha256: hash.digest('hex') };
  }

  private async createRelease(provider: RepositoryProvider, reference: RepositoryReference, tag: string, notes: string, branch: string, token: string): Promise<{ id: number; uploadUrl?: string }> {
    const response = await this.request(provider, `/repos/${encodeURIComponent(reference.owner)}/${encodeURIComponent(reference.name)}/releases`, token, { method: 'POST', body: JSON.stringify({ tag_name: tag, target_commitish: branch, name: tag, body: notes }) });
    if (!response.ok) throw await this.remoteError(provider, response, '创建 Release 失败');
    const body = await response.json() as { id?: unknown; upload_url?: unknown };
    if (typeof body.id !== 'number') throw new Error('平台未返回 Release 标识');
    return { id: body.id, uploadUrl: typeof body.upload_url === 'string' ? body.upload_url : undefined };
  }

  private async uploadAsset(provider: RepositoryProvider, reference: RepositoryReference, release: { id: number; uploadUrl?: string }, asset: { fileName: string; content: Blob }, token: string): Promise<string> {
    if (provider === 'github') {
      const uploadUrl = release.uploadUrl?.replace('{?name,label}', `?name=${encodeURIComponent(asset.fileName)}`);
      if (!uploadUrl) throw new Error('GitHub 未返回附件上传地址');
      const destination = new URL(uploadUrl);
      if (destination.protocol !== 'https:' || destination.hostname !== 'uploads.github.com' || destination.username || destination.password) throw new Error('GitHub 附件上传地址无效');
      const response = await fetch(uploadUrl, { method: 'POST', headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream', 'X-GitHub-Api-Version': '2022-11-28' }, body: asset.content, signal: AbortSignal.timeout(120_000) });
      if (!response.ok) throw await this.remoteError(provider, response, `上传 ${asset.fileName} 失败`);
      const body = await response.json() as { browser_download_url?: unknown };
      if (typeof body.browser_download_url !== 'string') throw new Error('GitHub 未返回附件下载地址');
      return body.browser_download_url;
    }
    const form = new FormData();
    form.append('file', asset.content, asset.fileName);
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
    const resourceWithToken = isGitHub || !token
      ? resource
      : `${resource}${separator}access_token=${encodeURIComponent(token)}`;
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json, application/json',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(isGitHub && token
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
    anonymous = false,
  ): Promise<Error> {
    const detail = await this.readRemoteErrorDetail(response);
    const suffix = detail ? `：${detail}` : '';
    const { status } = response;
    if (anonymous && [401, 403, 404, 429].includes(status)) {
      return new Error(`${action}：匿名访问失败（HTTP ${status}），请确认仓库公开、地址有效且未触发平台限流`);
    }
    if (status === 401) {
      return new Error(`${providerLabel(provider)} Token 无效或已过期`);
    }
    if (status === 403) {
      return new Error(`${action}：Token 没有仓库访问权限${suffix}`);
    }
    if (status === 404) {
      return new Error(`${action}：仓库不存在，或 Token 无权访问`);
    }
    return new Error(`${action}（HTTP ${status}）${suffix}`);
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
