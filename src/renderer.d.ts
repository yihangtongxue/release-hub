import type { CreateProductInput, Product } from './shared/product';

declare global {
  interface Window {
    releaseHub: {
      products: {
        list: () => Promise<Product[]>;
        create: (input: CreateProductInput) => Promise<Product>;
      };
    };
  }
}

export {};
