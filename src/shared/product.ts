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
