import { contextBridge, ipcRenderer } from 'electron';

import type {
  CreateProductInput,
  RepositoryProvider,
} from './shared/product';

contextBridge.exposeInMainWorld('releaseHub', {
  products: {
    list: () => ipcRenderer.invoke('products:list'),
    create: (input: CreateProductInput) =>
      ipcRenderer.invoke('products:create', input),
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    updateDefaultBranch: (defaultBranch: string) =>
      ipcRenderer.invoke('settings:update-default-branch', defaultBranch),
    verifyAndSaveToken: (provider: RepositoryProvider, token: string) =>
      ipcRenderer.invoke('settings:verify-and-save-token', provider, token),
  },
});
