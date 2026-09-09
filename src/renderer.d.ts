import type {
  AppSettings,
  CreateProductInput,
  Product,
  RepositoryInspection,
  RepositoryProvider,
  UpdateProductInput,
} from './shared/product';

declare global {
  interface Window {
    releaseHub: {
      products: {
        list: () => Promise<Product[]>;
        update: (input: UpdateProductInput) => Promise<Product>;
        create: (input: CreateProductInput) => Promise<Product>;
        inspectRepository: (
          input: CreateProductInput,
        ) => Promise<RepositoryInspection>;
        createWithInitialization: (
          input: CreateProductInput,
        ) => Promise<Product>;
      };
      settings: {
        get: () => Promise<AppSettings>;
        updateDefaultBranch: (defaultBranch: string) => Promise<AppSettings>;
        verifyAndSaveToken: (
          provider: RepositoryProvider,
          token: string,
        ) => Promise<AppSettings>;
      };
    };
  }
}

export {};
