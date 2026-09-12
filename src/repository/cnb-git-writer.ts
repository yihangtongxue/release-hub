import { validateReleaseBranch } from '../shared/repository-provider';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import * as git from 'isomorphic-git';
import type { HttpClient, TreeEntry } from 'isomorphic-git';

// CNB OpenAPI 目前只提供 Contents 读取、Blob 创建，没有完整的文件提交接口。
// 使用内置 JS Git 实现写入管理文件，不依赖用户安装 git，也不检出/执行仓库内容。
export async function writeCnbManagementFile(
  repositoryUrl: string, branch: string, filePath: string, content: string,
  expectedSha: string | undefined, branchExists: boolean, token: string, message: string,
): Promise<void> {
  branch = validateReleaseBranch(branch);
  if (!['.release-hub/manifest.json', '.release-hub/updates/stable.json'].includes(filePath)) {
    throw new Error('只能写入 ReleaseHub 管理文件');
  }
  const dir = await mkdtemp(path.join(os.tmpdir(), 'release-hub-cnb-'));
  const url = `${repositoryUrl}.git`;
  const http: HttpClient = {
    async request(request) {
      const destination = new URL(request.url);
      if (destination.origin !== 'https://cnb.cool' || destination.username || destination.password ||
          !destination.pathname.startsWith(`${new URL(url).pathname}/`)) {
        throw new Error('CNB Git 请求地址无效');
      }
      // CNB 无权访问时可能返回 404，不能只等待 Git 库收到 401 再鉴权。
      const headers = new Headers(request.headers);
      headers.set('Authorization', `Basic ${Buffer.from(`cnb:${token}`).toString('base64')}`);
      const response = await fetch(destination, {
        method: request.method || 'GET', headers,
        ...(request.body ? { body: Readable.from(request.body) as unknown as BodyInit, duplex: 'half' } : {}),
        redirect: 'error', signal: AbortSignal.timeout(120_000),
      } as RequestInit);
      async function* body() {
        if (!response.body) return;
        const reader = response.body.getReader();
        let size = 0;
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            size += chunk.value.byteLength;
            if (size > 256 * 1024 ** 2) throw new Error('CNB 发布分支代码体积过大，请使用独立的安装包发布仓库');
            yield chunk.value;
          }
        } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
      }
      return { url: response.url, method: request.method, statusCode: response.status,
        statusMessage: response.statusText, headers: Object.fromEntries(response.headers.entries()), body: body() };
    },
  };
  const onAuth = () => ({ username: 'cnb', password: token });
  try {
    let parent: string | undefined;
    let rootTree: string | undefined;
    if (branchExists) {
      await git.clone({ fs, http, dir, url, ref: branch, singleBranch: true, depth: 1, noTags: true, noCheckout: true, onAuth });
      parent = await git.resolveRef({ fs, dir, ref: `refs/heads/${branch}` });
      rootTree = (await git.readCommit({ fs, dir, oid: parent })).commit.tree;
    } else {
      if (expectedSha) throw new Error('远端发布分支已不存在，请重新检查仓库');
      await git.init({ fs, dir, defaultBranch: branch });
    }

    async function replaceFile(treeOid: string | undefined, segments: string[]): Promise<string> {
      const entries: TreeEntry[] = treeOid ? (await git.readTree({ fs, dir, oid: treeOid })).tree : [];
      const [name, ...rest] = segments;
      const previous = entries.find((entry) => entry.path === name);
      let next: TreeEntry;
      if (rest.length) {
        if (previous && previous.type !== 'tree') throw new Error('远端管理目录不是普通目录，请先修复');
        next = { path: name, mode: '040000', type: 'tree', oid: await replaceFile(previous?.oid, rest) };
      } else {
        if (previous && (previous.type !== 'blob' || !['100644', '100755'].includes(previous.mode))) {
          throw new Error('远端管理文件不是普通文件，请先修复');
        }
        if (previous?.oid !== expectedSha) throw new Error('远端管理文件已变化，本次停止写入，请重新发布');
        next = { path: name, mode: '100644', type: 'blob', oid: await git.writeBlob({ fs, dir, blob: Buffer.from(content) }) };
      }
      return git.writeTree({ fs, dir, tree: [...entries.filter((entry) => entry.path !== name), next] });
    }
    const tree = await replaceFile(rootTree, filePath.split('/'));
    const author = { name: 'ReleaseHub', email: 'release-hub@users.noreply.cnb.cool', timestamp: Math.floor(Date.now() / 1000), timezoneOffset: 0 };
    const oid = await git.writeCommit({ fs, dir, commit: { tree, parent: parent ? [parent] : [], author, committer: author, message: `${message}\n` } });
    await git.writeRef({ fs, dir, ref: `refs/heads/${branch}`, value: oid, force: true });
    // 仅更新临时仓库的本地 ref；远端始终非强制推送，拒绝并发造成的非快进更新。
    const result = await git.push({ fs, http, dir, url, ref: branch, remoteRef: branch, force: false, onAuth });
    if (!result.ok || Object.values(result.refs).some((ref) => !ref.ok)) {
      throw new Error('CNB 拒绝清单提交，请检查分支保护、写权限或并发发布');
    }
  } catch (error) {
    let detail = error instanceof Error ? error.message : '未知错误';
    for (const secret of [token, encodeURIComponent(token), Buffer.from(`cnb:${token}`).toString('base64')]) {
      if (secret) detail = detail.split(secret).join('[已隐藏]');
    }
    throw new Error(`CNB 管理文件写入失败：${detail}`);
  } finally { await rm(dir, { recursive: true, force: true }).catch(() => undefined); }
}
