import type {
  AppSettings,
  CreateProductInput,
  Product,
  RepositoryProvider,
} from './shared/product';

declare global {
  interface Window {
    releaseHub: {
      products: {
        list: () => Promise<Product[]>;
        create: (input: CreateProductInput) => Promise<Product>;
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
