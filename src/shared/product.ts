export type RepositoryProvider = 'github' | 'gitee';

export interface Product {
  id: string;
  name: string;
  description: string;
  currentVersion: string | null;
  repositoryProvider: RepositoryProvider;
  repositoryUrl: string;
  createdAt: number;
  updatedAt: number;
}

export interface CreateProductInput {
  name: string;
  description?: string;
  repositoryProvider: RepositoryProvider;
  repositoryUrl: string;
}

export interface UpdateProductInput {
  id: string;
  name: string;
  description?: string;
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
