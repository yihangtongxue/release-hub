import { validateReleaseAssetSize } from '../shared/release-asset-limits';
import { normalizeRepositoryUrl, validateReleaseBranch } from '../shared/repository-provider';
import { writeCnbManagementFile } from './cnb-git-writer';

const apiOrigin = 'https://api.cnb.cool';
export const cnbPermissionHint = 'CNB Token 需允许目标仓库，授权 account-profile 只读、repo-basic-info 只读、repo-code 读写、repo-release 读写';

interface CnbAsset {
  id: string; name: string; size: number; browser_download_url?: string;
  hash_algo?: string; hash_value?: string;
}
export interface CnbRelease {
  id: string; tag_name: string; draft?: boolean; updated_at?: string; assets: CnbAsset[];
}

export class CnbRepositoryClient {
  readonly repositoryUrl: string;
  private readonly root: string;
  constructor(repositoryUrl: string, private readonly token: string) {
    this.repositoryUrl = normalizeRepositoryUrl(repositoryUrl, 'cnb');
    this.root = new URL(this.repositoryUrl).pathname;
  }

  static async verifyToken(token: string): Promise<string> {
    const response = await fetch(`${apiOrigin}/user`, { headers: { Accept: 'application/vnd.cnb.api+json', Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw await CnbRepositoryClient.remoteError(response, token);
    const profile = await response.json() as { username?: unknown; locked?: boolean; freeze?: boolean };
    if (profile.locked || profile.freeze) throw new Error('CNB 账号已被锁定或冻结');
    if (typeof profile.username !== 'string' || !profile.username) throw new Error(`无法识别 CNB 账号。${cnbPermissionHint}`);
    return profile.username;
  }

  private async request(suffix = '', init: RequestInit = {}): Promise<Response> {
    return fetch(`${apiOrigin}${this.root}${suffix}`, {
      ...init, headers: { Accept: 'application/vnd.cnb.api+json',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) },
      redirect: 'error', signal: AbortSignal.timeout(30_000),
    });
  }

  private static async remoteError(response: Response, token: string): Promise<Error> {
    let detail = '';
    try { const body = await response.json() as { errmsg?: unknown }; if (typeof body.errmsg === 'string') detail = body.errmsg; } catch { /* 平台可能返回非 JSON 错误页。 */ }
    if (token) detail = detail.split(token).join('[已隐藏]').split(encodeURIComponent(token)).join('[已隐藏]');
    const hint = response.status === 401 ? 'Token 无效或已过期' : response.status === 403 ? cnbPermissionHint
      : response.status === 404 ? '资源不存在或没有访问权限' : response.status === 429 ? '请求过于频繁，请稍后重试'
      : response.status === 413 ? '附件大小超过平台限制' : '请检查网络、组织存储额度及仓库权限';
    return new Error(`CNB 请求失败（HTTP ${response.status}）：${hint}${detail ? `；${detail}` : ''}`);
  }

  private async requireOk(response: Response): Promise<void> {
    if (!response.ok) throw await CnbRepositoryClient.remoteError(response, this.token);
  }

  async getRepository(): Promise<{ default_branch?: string; empty_repo: boolean }> {
    const response = await this.request();
    await this.requireOk(response);
    const info = await response.json() as { visibility_level?: string; access?: string; freeze?: boolean };
    if (info.visibility_level !== 'Public') throw new Error('CNB 发布仓库必须公开，客户端才能匿名读取清单和下载安装包');
    if (info.freeze) throw new Error('CNB 仓库已冻结');
    if (this.token && !['Developer', 'Master', 'Owner'].includes(info.access || '')) throw new Error('CNB 账号至少需要目标仓库的开发者权限');
    const headResponse = await this.request('/-/git/head');
    if (headResponse.status !== 404) await this.requireOk(headResponse);
    const head = headResponse.ok ? await headResponse.json() as { name?: string } : {};
    const branchesResponse = await this.request('/-/git/branches?page=1&page_size=1');
    await this.requireOk(branchesResponse);
    const branches = await branchesResponse.json() as unknown;
    if (!Array.isArray(branches)) throw new Error('CNB 返回的分支列表无效');
    if (branches.length && !head.name) throw new Error('CNB 未返回有效默认分支，请在仓库设置中指定');
    return { default_branch: head.name, empty_repo: branches.length === 0 };
  }

  async getBranch(branch: string): Promise<{ sha: string; locked?: boolean; protected?: boolean } | null> {
    const response = await this.request(`/-/git/branches/${encodeURIComponent(branch)}`);
    if (response.status === 404) return null;
    await this.requireOk(response);
    const data = await response.json() as { commit?: { sha?: string }; locked?: boolean; protected?: boolean };
    if (!data.commit?.sha || !/^[a-f0-9]{40}$/i.test(data.commit.sha)) throw new Error('CNB 未返回有效的分支提交标识');
    return { sha: data.commit.sha, locked: data.locked, protected: data.protected };
  }

  async createBranch(branch: string, startPoint: string): Promise<void> {
    await this.requireOk(await this.request('/-/git/branches', { method: 'POST', body: JSON.stringify({ name: branch, start_point: startPoint }) }));
  }

  async getFile(filePath: string, branch: string): Promise<{ content: string; sha: string } | null> {
    const response = await this.request(`/-/git/contents/${filePath.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(branch)}`);
    if (response.status === 404) return null;
    await this.requireOk(response);
    const file = await response.json() as { type?: string; content?: string; sha?: string; encoding?: string };
    if (file.type === 'empty') return null;
    if (file.type !== 'blob' || file.encoding !== 'base64' || typeof file.content !== 'string' || !file.sha || !/^[a-f0-9]{40}$/i.test(file.sha)) {
      throw new Error(`CNB 的 ${filePath} 必须是普通的 JSON 文件`);
    }
    return { content: file.content, sha: file.sha };
  }

  async getPublicUpdateFile(branch: string): Promise<{ content: string } | null> {
    // OpenAPI 即使读取公开仓库也要求登录。安装客户端读取网站的 Raw 入口，
    // 不携带发布 Token 或浏览器 Cookie，响应本身就是文件内容。
    const url = `${this.repositoryUrl}/-/git/raw/${encodeURIComponent(validateReleaseBranch(branch))}/.release-hub/updates/stable.json`;
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
    if (response.status === 404) { await response.body?.cancel(); return null; }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error(`CNB 更新清单匿名读取失败（HTTP ${response.status}），请检查仓库公开状态和发布分支`);
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 1024 * 1024) throw new Error('CNB 更新清单超过 1 MiB，请检查远端文件');
        chunks.push(chunk.value);
      }
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    return { content: Buffer.concat(chunks).toString('base64') };
  }

  async putFile(filePath: string, content: string, branch: string, sha: string | undefined, message: string): Promise<void> {
    const remoteBranch = await this.getBranch(branch);
    if (remoteBranch?.locked || remoteBranch?.protected) throw new Error(`CNB 分支 ${branch} 已锁定或受保护，请为发布使用可直接写入的分支`);
    if (!remoteBranch && (filePath !== '.release-hub/manifest.json' || !(await this.getRepository()).empty_repo)) {
      throw new Error('CNB 发布分支已不存在，请重新检查仓库后再发布');
    }
    await writeCnbManagementFile(this.repositoryUrl, branch, filePath, content, sha, Boolean(remoteBranch), this.token, message);
    const written = await this.getFile(filePath, branch);
    if (!written || Buffer.from(written.content.replace(/\n/g, ''), 'base64').toString('utf8') !== content) {
      throw new Error('CNB 清单提交后的读取校验未通过，请核对远端状态');
    }
  }

  async listVersions(resource: 'releases' | 'tags', page: number): Promise<Array<{ id?: string; tag_name?: string; name?: string; updated_at?: string; commit?: { sha?: string } }>> {
    const response = await this.request(`${resource === 'releases' ? '/-/releases' : '/-/git/tags'}?page=${page}&page_size=100`);
    await this.requireOk(response);
    const entries = await response.json();
    if (!Array.isArray(entries)) throw new Error('CNB 返回的版本列表无效');
    return entries;
  }

  async getRelease(id: string): Promise<CnbRelease> {
    const response = await this.request(`/-/releases/${encodeURIComponent(id)}`);
    await this.requireOk(response);
    const release = await response.json() as CnbRelease;
    if (typeof release.id !== 'string' || !release.id || typeof release.tag_name !== 'string' || !release.tag_name || !Array.isArray(release.assets)) throw new Error('CNB 返回的 Release 信息无效');
    return release;
  }

  async deleteRelease(id: string): Promise<void> {
    // 用户确认完整覆盖后删除该版本的 Release 和附件，平台保留对应 Git 标签。
    await this.requireOk(await this.request(`/-/releases/${encodeURIComponent(id)}`, { method: 'DELETE' }));
  }

  async createRelease(tag: string, notes: string, branch: string): Promise<{ id: string }> {
    const response = await this.request('/-/releases', { method: 'POST', body: JSON.stringify({ tag_name: tag, name: tag, body: notes, target_commitish: branch, draft: false, prerelease: false, make_latest: 'false' }) });
    await this.requireOk(response);
    const release = await response.json() as { id?: unknown };
    if (typeof release.id !== 'string' || !release.id) throw new Error('CNB 未返回有效的 Release 标识');
    return { id: release.id };
  }

  async updateRelease(id: string, tag: string, notes: string): Promise<void> {
    await this.requireOk(await this.request(`/-/releases/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ name: tag, body: notes, draft: false, prerelease: false, make_latest: 'true' }) }));
  }

  async uploadAsset(id: string, asset: { fileName: string; content: Blob; sha256?: string }): Promise<string> {
    validateReleaseAssetSize('cnb', { fileName: asset.fileName, size: asset.content.size });
    // 完整覆盖由发布流程删除旧 Release 后重建；附件名与本地选择保持完全一致。
    const remoteName = asset.fileName;
    const response = await this.request(`/-/releases/${encodeURIComponent(id)}/asset-upload-url`, {
      method: 'POST', body: JSON.stringify({ asset_name: remoteName, size: asset.content.size, overwrite: false, ttl: 0 }),
    });
    await this.requireOk(response);
    const ticket = await response.json() as { upload_url?: string; verify_url?: string; expires_in_sec?: number };
    if (!ticket.upload_url || !ticket.verify_url || !Number.isFinite(ticket.expires_in_sec) || ticket.expires_in_sec! <= 0) {
      throw new Error('CNB 未返回有效的附件上传凭据');
    }
    const upload = new URL(ticket.upload_url);
    const verify = new URL(ticket.verify_url, apiOrigin);
    const verifyPrefix = `${this.root}/-/releases/${encodeURIComponent(id)}/asset-upload-confirmation/`;
    if (upload.protocol !== 'https:' || upload.port || upload.username || upload.password ||
        !(upload.hostname.endsWith('.cnb.cool') || upload.hostname.endsWith('.myqcloud.com')) ||
        verify.origin !== apiOrigin || verify.username || verify.password || !verify.pathname.startsWith(verifyPrefix)) {
      throw new Error('CNB 返回的附件上传或确认地址无效');
    }
    // expires_in_sec 是开始请求的凭据有效期，不是整个大文件上传的总时长。
    // 立即开始上传，不把 Token 带到对象存储，也不跟随上传重定向。
    let uploaded: Response;
    try {
      uploaded = await fetch(upload, { method: 'PUT', body: asset.content,
        headers: { 'Content-Type': 'application/octet-stream' }, redirect: 'error', signal: AbortSignal.timeout(60 * 60 * 1000) });
    } catch { throw new Error(`CNB 上传 ${asset.fileName} 中断或超时，请检查网络后重新发布；本次可能留下部分新附件`); }
    if (!uploaded.ok) throw new Error(`CNB 上传 ${asset.fileName} 失败（HTTP ${uploaded.status}），请检查文件大小、存储额度或上传凭据是否过期`);
    await uploaded.body?.cancel();
    verify.searchParams.set('ttl', '0');
    // 只向同一仓库、同一 Release 的 CNB API 确认接口发送 Token。
    await this.requireOk(await this.request(`${verify.pathname.slice(this.root.length)}${verify.search}`, { method: 'POST' }));
    const release = await this.getRelease(id);
    const remote = release.assets.find((entry) => entry.name === remoteName);
    if (!remote || remote.size !== asset.content.size) throw new Error('CNB 附件确认后未找到文件或文件大小不符，本次不切换更新清单');
    if (asset.sha256 && remote.hash_algo?.toLowerCase().replace(/-/g, '') === 'sha256' && remote.hash_value?.toLowerCase() !== asset.sha256) {
      throw new Error('CNB 附件 SHA-256 与本地不一致，本次不切换更新清单');
    }
    // 管理 API 要求登录；客户端必须使用网站公开入口，不能带发布 Token，
    // 也不能把重定向后会过期的对象存储地址保存到清单里。
    const downloadUrl = `${this.repositoryUrl}/-/releases/download/${encodeURIComponent(release.tag_name)}/${encodeURIComponent(remoteName)}`;
    const anonymous = await fetch(downloadUrl, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(30_000) });
    await anonymous.body?.cancel();
    if (!anonymous.ok) throw new Error(`CNB 网站附件匿名访问校验失败（HTTP ${anonymous.status}），附件已上传；请检查仓库公开状态。本次不切换更新清单`);
    const publicSize = anonymous.headers.get('content-length');
    if (publicSize !== null && Number(publicSize) !== asset.content.size) {
      throw new Error('CNB 公开下载入口返回的大小与上传文件不符，本次不切换更新清单');
    }
    return downloadUrl;
  }
}
