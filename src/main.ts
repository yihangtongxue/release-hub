import { app, BrowserWindow, dialog, ipcMain, safeStorage } from 'electron';
import { stat } from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import path from 'node:path';
import started from 'electron-squirrel-startup';

import { ProductRepository } from './database/product-repository';
import { ReleaseHubRepositoryService } from './repository/release-hub-repository-service';
import type {
  CreateProductInput,
  PublishReleaseInput,
  RepositoryProvider,
  UpdateProductInput,
  VerifiedConnection,
} from './shared/product';

const applicationId = 'com.yihang.releasehub';

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit();
}

if (process.platform === 'win32') {
  app.setAppUserModelId(applicationId);
}

let productRepository: ProductRepository | undefined;
const releaseHubRepositoryService = new ReleaseHubRepositoryService();

const getDevelopmentIconPath = (): string =>
  path.join(app.getAppPath(), 'assets', 'icons', 'release-hub.png');

const createWindow = () => {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    minWidth: 960,
    minHeight: 640,
    title: 'ReleaseHub',
    icon: app.isPackaged ? undefined : getDevelopmentIconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  // and load the index.html of the app.
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }

  // Open the DevTools.
  mainWindow.webContents.openDevTools();
};

const getDatabasePath = (): string => {
  if (app.isPackaged) {
    return path.join(
      app.getPath('userData'),
      'data',
      'release-hub.sqlite',
    );
  }

  return path.join(
    app.getAppPath(),
    '.release-hub',
    'data',
    'release-hub.sqlite',
  );
};

const registerProductIpcHandlers = (repository: ProductRepository) => {
  ipcMain.handle('products:list', () => repository.list());
  ipcMain.handle('products:update', (_event, input: UpdateProductInput) =>
    repository.update(input),
  );
  ipcMain.handle('products:delete', (_event, id: string) => repository.delete(id));
  ipcMain.handle('releases:list', (_event, productId: string) => repository.listReleases(productId));
  ipcMain.handle('releases:select-file', async () => {
    const selection = await dialog.showOpenDialog({ properties: ['openFile'] });
    if (selection.canceled || !selection.filePaths[0]) return null;
    const filePath = selection.filePaths[0];
    const file = await stat(filePath);
    return { filePath, fileName: path.basename(filePath), size: file.size };
  });
  ipcMain.handle('releases:publish', async (_event, input: PublishReleaseInput) => {
    const product = repository.getById(input.productId);
    const token = getProviderToken(repository, product.repositoryProvider);
    const release = await releaseHubRepositoryService.publish(product, input, token, repository.getSettings().defaultBranch);
    repository.saveRelease(release);
    return release;
  });
  ipcMain.handle(
    'products:inspect-repository',
    (_event, input: CreateProductInput) =>
      inspectProductRepository(repository, input),
  );
  ipcMain.handle(
    'products:create',
    async (
      _event,
      input: CreateProductInput,
      allowInitialization: boolean,
    ) => {
      const normalizedInput = repository.normalizeCreateInput(input);
      repository.assertCanCreate(normalizedInput);
      let inspection = await inspectProductRepository(repository, normalizedInput);

      if (inspection.state === 'needs-initialization') {
        if (!allowInitialization) {
          throw new Error('该仓库尚未初始化为 ReleaseHub 管理仓库');
        }

        inspection = await initializeProductRepository(repository, normalizedInput);
      }

      return repository.create(normalizedInput, inspection.currentVersion);
    },
  );
};

const getProviderToken = (
  repository: ProductRepository,
  provider: RepositoryProvider,
): string => {
  if (!repository.hasVerifiedConnection(provider)) {
    throw new Error('请先在设置中验证对应平台的 Token');
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('当前系统无法读取安全保存的 Token');
  }

  return safeStorage.decryptString(
    Buffer.from(repository.getEncryptedToken(provider)),
  );
};

const getSettingsForRenderer = (repository: ProductRepository) => {
  const settings = repository.getSettings();
  return {
  ...settings,
  connections: settings.connections.map((connection) => ({
    ...connection,
    token:
      connection.configured && safeStorage.isEncryptionAvailable()
        ? safeStorage.decryptString(
            Buffer.from(repository.getEncryptedToken(connection.provider)),
          )
        : null,
  })),
  };
};

const inspectProductRepository = async (
  repository: ProductRepository,
  input: CreateProductInput,
) => {
  const normalizedInput = repository.normalizeCreateInput(input);
  const token = getProviderToken(repository, normalizedInput.repositoryProvider);
  return releaseHubRepositoryService.inspect(
    normalizedInput,
    token,
    repository.getSettings().defaultBranch,
  );
};

const initializeProductRepository = async (
  repository: ProductRepository,
  input: CreateProductInput,
) => {
  const normalizedInput = repository.normalizeCreateInput(input);
  const token = getProviderToken(repository, normalizedInput.repositoryProvider);
  return releaseHubRepositoryService.initialize(
    normalizedInput,
    token,
    repository.getSettings().defaultBranch,
  );
};

const validateDefaultBranch = (defaultBranch: string): string => {
  const branch = defaultBranch?.trim();

  if (!branch) {
    throw new Error('请输入默认分支');
  }

  if (branch.length > 255 || /[\s~^:?*\[\\]/.test(branch)) {
    throw new Error('默认分支名称格式不正确');
  }

  return branch;
};

const verifyProviderToken = async (
  provider: RepositoryProvider,
  token: string,
): Promise<VerifiedConnection> => {
  if (provider !== 'github' && provider !== 'gitee') {
    throw new Error('不支持的代码托管平台');
  }

  const normalizedToken = token?.trim();

  if (!normalizedToken) {
    throw new Error('请输入 Token');
  }

  const request =
    provider === 'github'
      ? fetch('https://api.github.com/user', {
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${normalizedToken}`,
            'X-GitHub-Api-Version': '2022-11-28',
          },
          signal: AbortSignal.timeout(10000),
        })
      : fetch(
          `https://gitee.com/api/v5/user?access_token=${encodeURIComponent(normalizedToken)}`,
          { signal: AbortSignal.timeout(10000) },
        );
  const response = await request;

  if (!response.ok) {
    if (response.status === 401) {
      throw new Error('Token 无效或已过期');
    }

    throw new Error(`验证失败（HTTP ${response.status}）`);
  }

  const profile = (await response.json()) as { login?: unknown };
  if (typeof profile.login !== 'string' || !profile.login) {
    throw new Error('无法识别授权账号');
  }

  return {
    provider,
    accountLogin: profile.login,
    verifiedAt: Date.now(),
  };
};

const registerSettingsIpcHandlers = (repository: ProductRepository) => {
  ipcMain.handle('settings:get', () => getSettingsForRenderer(repository));
  ipcMain.handle('settings:update-default-branch', (_event, defaultBranch: string) => {
    repository.updateDefaultBranch(validateDefaultBranch(defaultBranch));
    return getSettingsForRenderer(repository);
  });
  ipcMain.handle(
    'settings:verify-and-save-token',
    async (_event, provider: RepositoryProvider, token: string) => {
      const verifiedConnection = await verifyProviderToken(provider, token);

      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error('当前系统无法安全保存 Token');
      }

      repository.saveVerifiedConnection(
        verifiedConnection,
        safeStorage.encryptString(token.trim()),
      );
      return getSettingsForRenderer(repository);
    },
  );
};

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.on('ready', () => {
  if (process.platform === 'darwin' && !app.isPackaged) {
    app.dock.setIcon(getDevelopmentIconPath());
  }

  productRepository = new ProductRepository(getDatabasePath());
  registerProductIpcHandlers(productRepository);
  registerSettingsIpcHandlers(productRepository);
  createWindow();
});

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.on('before-quit', () => {
  productRepository?.close();
});

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and import them here.
