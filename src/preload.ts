import { contextBridge, ipcRenderer } from 'electron';

import type { CreateProductInput } from './shared/product';

contextBridge.exposeInMainWorld('releaseHub', {
  products: {
    list: () => ipcRenderer.invoke('products:list'),
    create: (input: CreateProductInput) =>
      ipcRenderer.invoke('products:create', input),
  },
});
