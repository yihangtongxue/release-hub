import { contextBridge, ipcRenderer } from 'electron';

import type {
  CreateProductInput,
  PublishReleaseInput,
  ReleaseProgress,
  VerifyDownloadInput,
  RepositoryProvider,
  UpdateProductInput,
} from './shared/product';

contextBridge.exposeInMainWorld('releaseHub', {
  products: {
    list: () => ipcRenderer.invoke('products:list'),
    update: (input: UpdateProductInput) =>
      ipcRenderer.invoke('products:update', input),
    delete: (id: string) => ipcRenderer.invoke('products:delete', id),
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
  releases: {
    list: (productId: string) => ipcRenderer.invoke('releases:list', productId),
    selectFile: () => ipcRenderer.invoke('releases:select-file'),
    publish: (input: PublishReleaseInput) => ipcRenderer.invoke('releases:publish', input),
    getPublicUpdate: (productId: string) => ipcRenderer.invoke('releases:public-update', productId),
    verifyDownload: (input: VerifyDownloadInput) => ipcRenderer.invoke('releases:verify-download', input),
    onProgress: (callback: (progress: ReleaseProgress) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, progress: ReleaseProgress) => callback(progress);
      ipcRenderer.on('releases:progress', listener);
      return () => ipcRenderer.removeListener('releases:progress', listener);
    },
  },
});
