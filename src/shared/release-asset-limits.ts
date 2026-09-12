import type { RepositoryProvider, SelectedBuildFile } from './product';

export const releaseAssetLimits = {
  // Gitee 返回的限制为 100 MB，未明确字节单位；本地按十进制保守预检。
  gitee: { bytes: 100_000_000, exclusive: false, label: 'Gitee：单个附件预检上限 100 MB' },
  // https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases
  github: { bytes: 2 * 1024 ** 3, exclusive: true, label: 'GitHub：单个附件必须小于 2 GiB' },
  // CNB 官方附件插件支持 5 GB 以内；本应用使用十进制保守上限。
  cnb: { bytes: 5_000_000_000, exclusive: true, label: 'CNB：单个附件预检要求小于 5 GB，仍受组织可用存储额度限制' },
};

export function formatAssetSize(size: number): string {
  return `${(size / 1_000_000).toFixed(2)} MB`;
}

export function getReleaseAssetSizeError(
  provider: RepositoryProvider,
  file: Pick<SelectedBuildFile, 'fileName' | 'size'>,
): string | null {
  if (!Number.isSafeInteger(file.size) || file.size <= 0) return `${file.fileName} 不是有效的非空文件`;
  const limit = releaseAssetLimits[provider];
  if (file.size > limit.bytes || (limit.exclusive && file.size === limit.bytes)) {
    return `${file.fileName}（${formatAssetSize(file.size)}，${file.size.toLocaleString()} 字节）超过上传限制。${limit.label}；请缩小安装包或使用支持该文件大小的发布平台。`;
  }
  return null;
}

export function validateReleaseAssetSize(
  provider: RepositoryProvider,
  file: Pick<SelectedBuildFile, 'fileName' | 'size'>,
): void {
  const error = getReleaseAssetSizeError(provider, file);
  if (error) throw new Error(error);
}
