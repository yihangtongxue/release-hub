export type RepositoryProvider = 'github' | 'gitee' | 'cnb';
export type SignaturePolicy = 'optional' | 'required';

export interface Product {
  id: string;
  name: string;
  description: string;
  currentVersion: string | null;
  repositoryProvider: RepositoryProvider;
  repositoryUrl: string;
  /** 新建时由全局发布分支确定；旧记录为空，沿用历史的仓库默认分支行为。 */
  releaseBranch: string | null;
  /** null 表示旧产品尚未确认签名策略，发布前需要配置。 */
  signaturePolicy: SignaturePolicy | null;
  signatureAppId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface CreateProductInput {
  name: string;
  description?: string;
  repositoryProvider: RepositoryProvider;
  repositoryUrl: string;
  signaturePolicy: SignaturePolicy | null;
  signatureAppId?: string | null;
}

export interface UpdateProductInput {
  id: string;
  name: string;
  description?: string;
  signaturePolicy: SignaturePolicy | null;
  signatureAppId?: string | null;
}

export type BuildPlatform = 'macos' | 'windows' | 'android';

export interface BuildAssetInput {
  filePath: string;
  fileName: string;
  platform: BuildPlatform;
  architecture: string;
  packageType: string;
}

export interface PublishReleaseInput {
  productId: string;
  version: string;
  notes?: string;
  channel: 'stable';
  assets: BuildAssetInput[];
  /** 仅在用户确认覆盖后，回传冲突检查返回的标识。 */
  overwriteConfirmation?: string;
}

export type PublishReleaseResult =
  | { status: 'published'; release: ProductRelease }
  | { status: 'conflict'; version: string; message: string; confirmation: string };

export interface UpdateSignature {
  algorithm: 'ed25519';
  keyId: string;
  payload: string;
  signature: string;
}

export interface ReleaseAsset {
  id: string;
  fileName: string;
  platform: BuildPlatform;
  architecture: string;
  packageType: string;
  size: number;
  sha256: string;
  downloadUrl: string;
  updateSignature?: UpdateSignature;
}

export interface ProductRelease {
  id: string;
  productId: string;
  version: string;
  notes: string;
  channel: 'stable';
  publishedAt: number;
  assets: ReleaseAsset[];
}

export interface SelectedBuildFile {
  filePath: string;
  fileName: string;
  size: number;
}

export interface ReleaseProgress {
  productId: string;
  operation: 'publish' | 'verify';
  message: string;
}

export interface PublicUpdate {
  version: string;
  tag: string;
  assets: ReleaseAsset[];
}

export interface VerifyDownloadInput {
  productId: string;
  version: string;
  platform: BuildPlatform;
  architecture: string;
  packageType: string;
}

export interface DownloadVerification {
  version: string;
  fileName: string;
  size: number;
  sha256: string;
}

export interface RepositoryInspection {
  state: 'ready' | 'needs-initialization';
  reason: 'managed' | 'empty' | 'missing-manifest' | 'invalid-manifest';
  defaultBranch: string;
  currentVersion: string | null;
  message: string;
}

export interface ProviderConnection {
  provider: RepositoryProvider;
  configured: boolean;
  accountLogin: string | null;
  verifiedAt: number | null;
  token: string | null;
}

export interface AppSettings {
  defaultBranch: string;
  connections: ProviderConnection[];
}

export interface VerifiedConnection {
  provider: RepositoryProvider;
  accountLogin: string;
  verifiedAt: number;
}
