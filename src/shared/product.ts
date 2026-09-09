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

export interface ProviderConnection {
  provider: RepositoryProvider;
  configured: boolean;
  accountLogin: string | null;
  verifiedAt: number | null;
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
