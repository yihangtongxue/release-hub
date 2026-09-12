import type { RepositoryProvider } from './product';

export const repositoryProviders: RepositoryProvider[] = ['github', 'gitee', 'cnb'];
export const repositoryProviderLabels: Record<RepositoryProvider, string> = { github: 'GitHub', gitee: 'Gitee', cnb: 'CNB' };
const repositoryHosts: Record<RepositoryProvider, string> = { github: 'github.com', gitee: 'gitee.com', cnb: 'cnb.cool' };

export function normalizeRepositoryUrl(rawUrl: string, provider: RepositoryProvider): string {
  let url: URL;
  try { url = new URL(rawUrl.trim()); } catch { throw new Error('请输入有效的仓库地址'); }
  const segments = url.pathname.replace(/\/+$/, '').split('/').slice(1);
  if (url.protocol !== 'https:' || url.hostname !== repositoryHosts[provider] || url.port ||
      url.username || url.password || url.search || url.hash ||
      (provider === 'cnb' ? segments.length < 2 : segments.length !== 2) ||
      segments.some((segment) => !/^[A-Za-z0-9_.-]+$/.test(segment) || ['.', '..', '-'].includes(segment))) {
    throw new Error(`请输入有效的 ${repositoryProviderLabels[provider]} 仓库根地址，不要包含分支、Release 页面或查询参数`);
  }
  segments[segments.length - 1] = segments[segments.length - 1].replace(/\.git$/, '');
  if (!segments[segments.length - 1]) throw new Error('仓库名称不能为空');
  return `https://${repositoryHosts[provider]}/${segments.join('/')}`;
}

export function repositoryReleasesUrl(provider: RepositoryProvider, repositoryUrl: string): string {
  return `${repositoryUrl}${provider === 'cnb' ? '/-/releases' : '/releases'}`;
}

export function validateReleaseBranch(value: string): string {
  const branch = typeof value === 'string' ? value.trim() : '';
  if (!branch || branch.length > 255 || branch === '@' || branch.startsWith('-') ||
      /[\s\x00-\x1f\x7f~^:?*\[\\]/.test(branch) || branch.includes('..') || branch.includes('@{') ||
      branch.endsWith('.') || branch.split('/').some((part) => !part || part.startsWith('.') || part.endsWith('.lock'))) {
    throw new Error('发布分支名称格式不正确');
  }
  return branch;
}

export const externalResources = {
  'cnb-home': 'https://cnb.cool/',
  'cnb-token': 'https://docs.cnb.cool/zh/guide/access-token.html',
  'cnb-pricing': 'https://docs.cnb.cool/zh/pricing.html',
} as const;
export type ExternalResource = keyof typeof externalResources;
