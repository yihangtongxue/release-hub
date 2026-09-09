import { contextBridge, ipcRenderer } from 'electron';

import type {
  CreateProductInput,
  RepositoryInspection,
  RepositoryProvider,
  UpdateProductInput,
} from './shared/product';

contextBridge.exposeInMainWorld('releaseHub', {
  products: {
    list: () => ipcRenderer.invoke('products:list'),
    update: (input: UpdateProductInput) =>
      ipcRenderer.invoke('products:update', input),
    create: (input: CreateProductInput) =>
      ipcRenderer.invoke('products:create', input, false),
    inspectRepository: (input: CreateProductInput) =>
      ipcRenderer.invoke('products:inspect-repository', input),
    createWithInitialization: (input: CreateProductInput) =>
      ipcRenderer.invoke('products:create', input, true),
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    updateDefaultBranch: (defaultBranch: string) =>
      ipcRenderer.invoke('settings:update-default-branch', defaultBranch),
    verifyAndSaveToken: (provider: RepositoryProvider, token: string) =>
      ipcRenderer.invoke('settings:verify-and-save-token', provider, token),
  },
});
