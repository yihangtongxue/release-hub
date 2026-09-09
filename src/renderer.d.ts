import type {
  AppSettings,
  CreateProductInput,
  Product,
  ProductRelease,
  PublicUpdate,
  ReleaseProgress,
  VerifyDownloadInput,
  DownloadVerification,
  PublishReleaseInput,
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
        delete: (id: string) => Promise<void>;
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
      releases: {
        list: (productId: string) => Promise<ProductRelease[]>;
        selectFile: () => Promise<import('./shared/product').SelectedBuildFile | null>;
        publish: (input: PublishReleaseInput) => Promise<ProductRelease>;
        getPublicUpdate: (productId: string) => Promise<PublicUpdate>;
        verifyDownload: (input: VerifyDownloadInput) => Promise<DownloadVerification>;
        onProgress: (callback: (progress: ReleaseProgress) => void) => () => void;
      };
    };
  }
}

export {};
