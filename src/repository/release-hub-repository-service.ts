import { CnbRepositoryClient } from './cnb-repository-client';
import { normalizeRepositoryUrl, repositoryProviderLabels, repositoryReleasesUrl, validateReleaseBranch } from '../shared/repository-provider';
import { Buffer } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import { openAsBlob } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { compareVersions, stableVersion, targetKey, validatePublishInput, validateTarget } from '../shared/release-validation';
import { readArtifactSignature } from './artifact-signature';
import { normalizeSignatureSettings } from '../shared/signature-policy';
import { validateReleaseAssetSize } from '../shared/release-asset-limits';

import type {
  CreateProductInput,
  Product,
  ProductRelease,
  PublishReleaseInput,
  PublishReleaseResult,
  RepositoryInspection,
  RepositoryProvider,
  PublicUpdate,
  VerifyDownloadInput,
  DownloadVerification,
  UpdateSignature,
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

interface RemoteVersionConflict {
  releases: { id: number | string; tag: string; updatedAt: string | null }[];
  tags: { name: string; sha: string | null }[];
}

const providerLabel = (provider: RepositoryProvider): string => repositoryProviderLabels[provider];
const parseRepositoryReference = (input: CreateProductInput): RepositoryReference => {
  const parts = new URL(normalizeRepositoryUrl(input.repositoryUrl, input.repositoryProvider)).pathname.split('/').filter(Boolean);
  return { owner: parts.slice(0, -1).join('/'), name: parts[parts.length - 1] };
};
const cnbClient = (reference: RepositoryReference, token: string) =>
  new CnbRepositoryClient(`https://cnb.cool/${reference.owner}/${reference.name}`, token);

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
    localVersionExists = false,
  ): Promise<PublishReleaseResult> {
    let stage = '校验发布信息';
    let remoteState = '尚未创建远端 Release，已有版本未修改。';
    const report = (message: string) => { stage = message; progress(message); };
    try {
      report(stage);
      input = validatePublishInput(input);
      const signatureSettings = normalizeSignatureSettings(product);
      const { version } = input;
      const prepared: (Awaited<ReturnType<ReleaseHubRepositoryService['readAsset']>> & { updateSignature?: UpdateSignature })[] = [];
      for (const [index, asset] of input.assets.entries()) {
        report(`校验文件 ${index + 1}/${input.assets.length}：${asset.fileName}`);
        const metadata = await this.readAsset(asset.filePath, asset.fileName, product.repositoryProvider);
        const updateSignature = await readArtifactSignature(asset, version, metadata, signatureSettings);
        if (updateSignature) report(`签名校验通过：${asset.fileName}`);
        prepared.push({ ...metadata, updateSignature });
      }
      report('检查仓库与版本冲突');
      const inspection = await this.inspect(product, token, configuredDefaultBranch);
      if (inspection.state !== 'ready') throw new Error('仓库尚未完成 ReleaseHub 初始化');
      const reference = parseRepositoryReference(product);
      const provider = product.repositoryProvider;
      const existing = await this.getFile(provider, reference, latestReleasePath, inspection.defaultBranch, token);
      const manifestVersionExists = this.assertNotOlder(version, existing);
      const conflict = await this.inspectRemoteVersion(provider, reference, version, token);
      const tag = `v${version}`;
      const remoteVersionExists = manifestVersionExists || conflict.releases.length > 0 || conflict.tags.length > 0;
      if (remoteVersionExists || localVersionExists) {
        // 确认只适用于刚展示的仓库、分支和版本状态；远端变化后必须重新确认。
        const confirmation = createHash('sha256').update(JSON.stringify({
          productId: product.id, provider, reference, branch: inspection.defaultBranch,
          version, existing, conflict, localVersionExists, overwriteMode: 'replace-release-with-original-filenames',
        })).digest('hex');
        if (input.overwriteConfirmation !== confirmation) {
          return {
            status: 'conflict', version, confirmation,
            message: `${input.overwriteConfirmation ? '版本状态已变化，请重新确认。' : ''}${remoteVersionExists
              ? `远端已存在 ${tag} 的 Release、标签或更新清单。`
              : `本地已有 ${tag} 的发布记录。`}覆盖后将以本次填写的更新说明和构建产物替换该版本，并更新客户端清单及本地记录。已有 Release 及其全部附件会被删除后重新创建，仅保留本次选择的附件，并使用原始文件名（包括清理之前的随机名附件）。覆盖期间旧附件可能无法下载；若覆盖失败，需要重新发布恢复。已有标签的代码提交保持不变。`,
          };
        }
      }
      // 在任何删除或创建之前，再确认客户端清单没有被并发发布修改。
      const beforeWrite = await this.getFile(provider, reference, latestReleasePath, inspection.defaultBranch, token);
      if (beforeWrite?.sha !== existing?.sha || beforeWrite?.content !== existing?.content) {
        throw new Error('更新清单已被其他发布修改，请重新发布并确认远端版本');
      }
      let removedExistingRelease = false;
      for (const oldRelease of conflict.releases) {
        report(`替换已有 Release：${oldRelease.tag}`);
        remoteState = `已请求删除 ${oldRelease.tag} 的旧 Release 和附件，结果尚未确认；更新清单尚未修改，旧附件可能无法下载。请核对远端状态后重新发布并确认覆盖。`;
        await this.deleteRelease(provider, reference, oldRelease.id, token);
        removedExistingRelease = true;
      }
      report('创建 Release');
      remoteState = `${removedExistingRelease ? '旧 Release 和附件已删除，更新清单尚未修改，旧附件可能无法下载。' : ''}已请求创建 ${tag}，返回结果尚未确认。请到 ${repositoryReleasesUrl(provider, product.repositoryUrl)} 核对后重新发布，遇到同版本提示可确认覆盖。`;
      const release = await this.createRelease(provider, reference, tag, input.notes || '', inspection.defaultBranch, token);
      remoteState = `远端 ${tag} 已创建，可能有部分新附件；更新清单尚未修改。${removedExistingRelease ? '旧 Release 和附件已删除，旧附件可能无法下载。' : ''}可以重新发布并确认覆盖以恢复该版本。`;
      const assets: ProductRelease['assets'] = [];
      for (const [index, asset] of input.assets.entries()) {
        report(`上传附件 ${index + 1}/${input.assets.length}：${asset.fileName}`);
        const metadata = prepared[index];
        const downloadUrl = await this.uploadAsset(provider, reference, release, metadata, token);
        this.validateDownloadUrl(downloadUrl);
        assets.push({ id: randomUUID(), fileName: metadata.fileName, platform: asset.platform, architecture: asset.architecture, packageType: asset.packageType, size: metadata.size, sha256: metadata.sha256, downloadUrl,
          ...(metadata.updateSignature ? { updateSignature: metadata.updateSignature } : {}) });
      }
      const result: ProductRelease = { id: randomUUID(), productId: product.id, version, notes: input.notes || '', channel: 'stable', publishedAt: Date.now(), assets };
      report('再次检查最新版');
      const current = await this.getFile(provider, reference, latestReleasePath, inspection.defaultBranch, token);
      this.assertNotOlder(version, current);
      if (current?.sha !== existing?.sha || current?.content !== existing?.content) throw new Error('更新清单已被其他发布修改，本次停止更新，请核对远端版本');
      if (provider === 'cnb') {
        report('更新 Release 说明');
        await cnbClient(reference, token).updateRelease(String(release.id), tag, input.notes || '');
      }
      report('更新客户端清单');
      remoteState = `远端 ${tag} 和全部附件已创建；更新清单写入结果未确认。请到 ${repositoryReleasesUrl(provider, product.repositoryUrl)} 及仓库中的 stable.json 核对状态，勿直接重复发布。`;
      await this.putFile(provider, reference, latestReleasePath, `${JSON.stringify({ schemaVersion: 1, channel: 'stable', version, tag, publishedAt: result.publishedAt, notes: result.notes, assets }, null, 2)}\n`, inspection.defaultBranch, existing?.sha, token, `发布 ${tag} 更新清单`);
      return { status: 'published', release: result };
    } catch (error) {
      const detail = error instanceof Error ? error.message : '未知错误';
      throw new Error(`${stage}失败：${detail}\n${remoteState}`);
    }
  }

  private assertNotOlder(version: string, file: RemoteFile | null): boolean {
    if (!file) return false;
    const current = decodeJsonFile<LatestRelease>(file);
    if (!current || typeof current.version !== 'string') throw new Error('远端更新清单版本无效，请先修复清单');
    const comparison = compareVersions(version, current.version);
    if (comparison < 0) throw new Error(`版本不能低于当前稳定版 ${current.version}，不允许降级`);
    return comparison === 0;
  }

  async getPublicUpdate(product: Product, defaultBranch: string): Promise<PublicUpdate> {
    const reference = parseRepositoryReference(product);
    // 有意不传 Token：模拟没有发布凭据的客户端。
    let file: RemoteFile | null;
    if (product.repositoryProvider === 'cnb') {
      // CNB 管理 API 不接受匿名请求，公开客户端直接读取固定发布分支的 Raw 文件。
      file = await cnbClient(reference, '').getPublicUpdateFile(product.releaseBranch || defaultBranch);
    } else {
      const repository = await this.getRepository(product.repositoryProvider, reference, '');
      const branch = this.getEffectiveBranch(repository, defaultBranch, product.releaseBranch);
      file = await this.getFile(product.repositoryProvider, reference, latestReleasePath, branch, '');
    }
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
    const signal = AbortSignal.timeout(60 * 60 * 1000);
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

  private async inspectRemoteVersion(provider: RepositoryProvider, reference: RepositoryReference, version: string, token: string): Promise<RemoteVersionConflict> {
    const root = `/repos/${encodeURIComponent(reference.owner)}/${encodeURIComponent(reference.name)}`;
    const conflict: RemoteVersionConflict = { releases: [], tags: [] };
    // 同时检查 Release（含可见草稿）和标签，同版本需要确认，较低版本仍然拒绝。
    for (const resource of ['releases', 'tags'] as const) {
      let complete = false;
      for (let page = 1; page <= 100; page++) {
        let items: Array<{ id?: number | string; tag_name?: string; name?: string; updated_at?: string; commit?: { sha?: string } }>;
        if (provider === 'cnb') items = await cnbClient(reference, token).listVersions(resource, page);
        else {
          const response = await this.request(provider, `${root}/${resource}?per_page=100&page=${page}`, token);
          if (!response.ok) throw await this.remoteError(provider, response, '检查远端版本失败');
          items = await response.json();
        }
        if (!Array.isArray(items)) throw new Error('平台返回的版本列表无效');
        for (const item of items) {
          const tag = resource === 'releases' ? item?.tag_name : item?.name;
          if (typeof tag !== 'string') continue;
          const candidate = tag.replace(/^v/, '');
          if (!candidate || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(candidate)) continue;
          const comparison = compareVersions(version, candidate);
          if (comparison < 0) throw new Error(`远端已有更高版本或标签 ${tag}，不能发布较低版本`);
          if (comparison === 0) {
            if (resource === 'releases') {
              if (provider === 'cnb' ? typeof item.id !== 'string' || !item.id : typeof item.id !== 'number' || !Number.isSafeInteger(item.id) || item.id <= 0) throw new Error('平台未返回有效的 Release 标识，无法覆盖');
              conflict.releases.push({ id: item.id!, tag, updatedAt: item.updated_at ?? null });
            } else {
              conflict.tags.push({ name: tag, sha: item.commit?.sha ?? null });
            }
          }
        }
        if (items.length < 100) { complete = true; break; }
      }
      if (!complete) throw new Error('远端版本过多，本次未能完成冲突检查');
    }
    conflict.releases.sort((left, right) => String(left.id).localeCompare(String(right.id)));
    conflict.tags.sort((left, right) => left.name.localeCompare(right.name));
    return conflict;
  }
  async inspect(
    product: CreateProductInput & Partial<Pick<Product, 'releaseBranch'>>,
    token: string,
    configuredDefaultBranch: string,
    releaseBranch?: string,
  ): Promise<RepositoryInspection> {
    const reference = parseRepositoryReference(product);
    const repository = await this.getRepository(product.repositoryProvider, reference, token);
    const branch = this.getEffectiveBranch(
      repository,
      configuredDefaultBranch,
      releaseBranch ?? product.releaseBranch,
    );
    if (product.repositoryProvider === 'cnb') {
      const state = await cnbClient(reference, token).getBranch(branch);
      if (state?.locked || state?.protected) throw new Error('CNB 发布分支已锁定或受保护，请选择允许直接写入的独立分支');
    }
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
    product: CreateProductInput & Partial<Pick<Product, 'releaseBranch'>>,
    token: string,
    configuredDefaultBranch: string,
    releaseBranch?: string,
  ): Promise<RepositoryInspection> {
    const before = await this.inspect(product, token, configuredDefaultBranch, releaseBranch);
    if (before.state === 'ready') {
      return before;
    }

    const reference = parseRepositoryReference(product);
    const repository = await this.getRepository(product.repositoryProvider, reference, token);
    await this.ensureBranch(
      product.repositoryProvider,
      reference,
      repository,
      before.defaultBranch,
      token,
    );
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

    return this.inspect(product, token, configuredDefaultBranch, releaseBranch);
  }

  private async getRepository(
    provider: RepositoryProvider,
    reference: RepositoryReference,
    token: string,
  ): Promise<{ default_branch?: unknown; size?: unknown; empty_repo?: unknown }> {
    if (provider === 'cnb') return cnbClient(reference, token).getRepository();
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

  private async ensureBranch(
    provider: RepositoryProvider,
    reference: RepositoryReference,
    repository: { default_branch?: unknown; size?: unknown; empty_repo?: unknown },
    branch: string,
    token: string,
  ): Promise<void> {
    if (repository.size === 0 || repository.empty_repo === true) {
      // GitHub 的 Contents API 可在空仓库中通过首次写入创建指定分支；Gitee 同样
      // 由后续的首次文件提交完成初始化。
      return;
    }

    if (await this.getBranch(provider, reference, branch, token)) return;
    const sourceBranch = typeof repository.default_branch === 'string' && repository.default_branch
      ? repository.default_branch
      : undefined;
    if (!sourceBranch) {
      throw new Error(`仓库没有可用于创建发布分支 ${branch} 的默认分支`);
    }
    const source = await this.getBranch(provider, reference, sourceBranch, token);
    if (!source) {
      throw new Error(`无法读取仓库默认分支 ${sourceBranch}，不能创建发布分支 ${branch}`);
    }

    if (provider === 'cnb') return cnbClient(reference, token).createBranch(branch, source.sha);
    const root = `/repos/${encodeURIComponent(reference.owner)}/${encodeURIComponent(reference.name)}`;
    const response = provider === 'github'
      ? await this.request(provider, `${root}/git/refs`, token, {
          method: 'POST',
          body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: source.sha }),
        })
      : await this.request(provider, `${root}/branches`, token, {
          method: 'POST',
          // Gitee v5 uses snake_case in the JSON request body.
          body: JSON.stringify({ branch_name: branch, refs: sourceBranch }),
        });
    if (!response.ok) {
      throw await this.remoteError(provider, response, `创建发布分支 ${branch} 失败`);
    }
  }

  private async getBranch(
    provider: RepositoryProvider,
    reference: RepositoryReference,
    branch: string,
    token: string,
  ): Promise<{ sha: string } | null> {
    if (provider === 'cnb') return cnbClient(reference, token).getBranch(branch);
    const response = await this.request(
      provider,
      `/repos/${encodeURIComponent(reference.owner)}/${encodeURIComponent(reference.name)}/branches/${encodeURIComponent(branch)}`,
      token,
    );
    if (response.status === 404) return null;
    if (!response.ok) throw await this.remoteError(provider, response, `读取分支 ${branch} 失败`);
    const body = await response.json() as { commit?: { sha?: unknown } };
    if (typeof body.commit?.sha !== 'string' || !body.commit.sha) {
      throw new Error(`平台未返回分支 ${branch} 的提交标识`);
    }
    return { sha: body.commit.sha };
  }

  private async getFile(
    provider: RepositoryProvider,
    reference: RepositoryReference,
    filePath: string,
    branch: string,
    token: string,
  ): Promise<RemoteFile | null> {
    if (provider === 'cnb') return cnbClient(reference, token).getFile(filePath, branch);
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

    const body = await response.json() as unknown;
    // Gitee 对不存在的 Contents 路径可能返回 HTTP 200 和空数组，而不是 404。
    // 这与“尚未发布 stable.json”的正常状态等价，不能交给 JSON 文件解码器。
    if (Array.isArray(body)) return null;
    if (!body || typeof body !== 'object' || typeof (body as RemoteFile).content !== 'string') {
      throw new Error(`平台返回的 ${filePath} 内容格式无效`);
    }
    return body as RemoteFile;
  }

  private async putFile(
    provider: RepositoryProvider,
    reference: RepositoryReference,
    filePath: string,
    content: string,
    branch: string,
    sha: string | undefined,
    token: string,
    message = '初始化 ReleaseHub 管理文件',
  ): Promise<void> {
    if (provider === 'cnb') return cnbClient(reference, token).putFile(filePath, content, branch, sha, message);
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

  private async readAsset(filePath: string, expectedName: string, provider: RepositoryProvider) {
    if (!path.isAbsolute(filePath) || path.basename(filePath) !== expectedName) throw new Error('文件名与所选文件不一致，请重新选择');
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error(`${expectedName} 不是有效文件`);
    if (!info.size) throw new Error(`${expectedName} 是空文件`);
    // 使用磁盘上的实际大小，不信任选择文件时的缓存；必须在任何远端修改前完成。
    validateReleaseAssetSize(provider, { fileName: expectedName, size: info.size });
    const content = await openAsBlob(filePath);
    validateReleaseAssetSize(provider, { fileName: expectedName, size: content.size });
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

  private async deleteRelease(provider: RepositoryProvider, reference: RepositoryReference, releaseId: number | string, token: string): Promise<void> {
    if (provider === 'cnb') return cnbClient(reference, token).deleteRelease(String(releaseId));
    // 只替换该版本的 Release 和附件，不删除或移动 Git 标签。
    const response = await this.request(provider,
      `/repos/${encodeURIComponent(reference.owner)}/${encodeURIComponent(reference.name)}/releases/${releaseId}`,
      token, { method: 'DELETE' });
    if (!response.ok) throw await this.remoteError(provider, response, '删除旧 Release 失败');
  }

  private async createRelease(provider: RepositoryProvider, reference: RepositoryReference, tag: string, notes: string, branch: string, token: string): Promise<{ id: number | string; uploadUrl?: string }> {
    if (provider === 'cnb') return cnbClient(reference, token).createRelease(tag, notes, branch);
    const response = await this.request(provider, `/repos/${encodeURIComponent(reference.owner)}/${encodeURIComponent(reference.name)}/releases`, token, { method: 'POST', body: JSON.stringify({ tag_name: tag, target_commitish: branch, name: tag, body: notes }) });
    if (!response.ok) throw await this.remoteError(provider, response, '创建 Release 失败');
    const body = await response.json() as { id?: unknown; upload_url?: unknown };
    if (typeof body.id !== 'number') throw new Error('平台未返回 Release 标识');
    return { id: body.id, uploadUrl: typeof body.upload_url === 'string' ? body.upload_url : undefined };
  }

  private async uploadAsset(provider: RepositoryProvider, reference: RepositoryReference, release: { id: number | string; uploadUrl?: string }, asset: { fileName: string; content: Blob; sha256?: string }, token: string): Promise<string> {
    if (provider === 'cnb') return cnbClient(reference, token).uploadAsset(String(release.id), asset);
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
    if (provider === 'cnb') throw new Error('CNB 必须使用专用 API 客户端');
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

  private getEffectiveBranch(
    repository: { default_branch?: unknown },
    configuredDefaultBranch: string,
    releaseBranch?: string | null,
  ): string {
    if (releaseBranch) return validateReleaseBranch(releaseBranch);
    return validateReleaseBranch(typeof repository.default_branch === 'string' && repository.default_branch
      ? repository.default_branch
      : configuredDefaultBranch);
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
