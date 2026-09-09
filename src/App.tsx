import {
  AppstoreOutlined,
  ArrowLeftOutlined,
  CloudUploadOutlined,
  PlusOutlined,
  SettingOutlined,
} from '@ant-design/icons';
import {
  Alert,
  Button,
  Card,
  ConfigProvider,
  Empty,
  Form,
  Input,
  Layout,
  Menu,
  message,
  Modal,
  Radio,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { MenuProps, TableColumnsType } from 'antd';
import { useEffect, useRef, useState } from 'react';
import { buildTargetOptions, stableVersion, targetKey, validatePublishInput } from './shared/release-validation';

import type {
  AppSettings,
  BuildPlatform,
  PublicUpdate,
  DownloadVerification,
  CreateProductInput,
  Product,
  ProductRelease,
  RepositoryProvider,
  SelectedBuildFile,
  UpdateProductInput,
} from './shared/product';

type PageKey = 'products' | 'settings' | 'versions';
type ProductFormValues = CreateProductInput;
type EditProductFormValues = Pick<UpdateProductInput, 'name' | 'description'>;

interface DraftAsset {
  id: number;
  platform: BuildPlatform;
  architecture: string;
  packageType: string;
  file: SelectedBuildFile | null;
}

const createDraftAsset = (id: number): DraftAsset => ({
  id,
  platform: 'macos',
  architecture: 'arm64',
  packageType: 'dmg',
  file: null,
});

const readableErrorMessage = (error: unknown, fallback: string): string => {
  if (!(error instanceof Error)) {
    return fallback;
  }

  return error.message.replace(
    /^Error invoking remote method '[^']+': Error: /,
    '',
  );
};

const menuItems: MenuProps['items'] = [
  { key: 'products', icon: <AppstoreOutlined />, label: '产品' },
  { key: 'settings', icon: <SettingOutlined />, label: '设置' },
];

function App() {
  const [activePage, setActivePage] = useState<PageKey>('products');
  const [products, setProducts] = useState<Product[]>([]);
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [isSavingProduct, setIsSavingProduct] = useState(false);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [isSavingEdit, setIsSavingEdit] = useState(false);
  const [versionProduct, setVersionProduct] = useState<Product | null>(null);
  const [isPublishVersionModalOpen, setIsPublishVersionModalOpen] =
    useState(false);
  const [draftAssets, setDraftAssets] = useState<DraftAsset[]>([
    createDraftAsset(1),
  ]);
  const [releases, setReleases] = useState<ProductRelease[]>([]);
  const [isPublishing, setIsPublishing] = useState(false);
  const [publishProgress, setPublishProgress] = useState('');
  const [publishError, setPublishError] = useState('');
  const publishingRef = useRef(false);
  const [isSelectingFile, setIsSelectingFile] = useState(false);
  const [isLoadingReleases, setIsLoadingReleases] = useState(false);
  const [releaseLoadError, setReleaseLoadError] = useState('');
  const [isVerifyOpen, setIsVerifyOpen] = useState(false);
  const [isVerifyingDownload, setIsVerifyingDownload] = useState(false);
  const [isLoadingUpdate, setIsLoadingUpdate] = useState(false);
  const [publicUpdate, setPublicUpdate] = useState<PublicUpdate | null>(null);
  const [verifyTarget, setVerifyTarget] = useState('');
  const [verifyProgress, setVerifyProgress] = useState('');
  const [verifyError, setVerifyError] = useState('');
  const [verification, setVerification] = useState<DownloadVerification | null>(null);
  const [isSavingBranch, setIsSavingBranch] = useState(false);
  const [verifyingProvider, setVerifyingProvider] =
    useState<RepositoryProvider | null>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [tokens, setTokens] = useState<
    Partial<Record<RepositoryProvider, string>>
  >({});
  const [form] = Form.useForm<ProductFormValues>();
  const [editForm] = Form.useForm<EditProductFormValues>();
  const [publishForm] = Form.useForm<{ version: string; notes?: string; channel: 'stable' }>();
  const [settingsForm] = Form.useForm<{ defaultBranch: string }>();
  const [messageApi, messageContextHolder] = message.useMessage();

  const loadProducts = async () => {
    try {
      const savedProducts = await window.releaseHub.products.list();
      setProducts(savedProducts);
    } catch (error) {
      const description = readableErrorMessage(error, '请稍后重试');
      messageApi.error(`读取产品失败：${description}`);
    }
  };

  const loadSettings = async () => {
    try {
      const savedSettings = await window.releaseHub.settings.get();
      setSettings(savedSettings);
      setTokens(
        Object.fromEntries(
          savedSettings.connections
            .filter((connection) => connection.token)
            .map((connection) => [connection.provider, connection.token]),
        ),
      );
      settingsForm.setFieldsValue({
        defaultBranch: savedSettings.defaultBranch,
      });
    } catch (error) {
      const description = readableErrorMessage(error, '请稍后重试');
      messageApi.error(`读取设置失败：${description}`);
    }
  };

  useEffect(() => {
    void loadProducts();
    void loadSettings();
  }, [messageApi]);

  const isProviderConfigured = (provider: RepositoryProvider): boolean =>
    Boolean(
      settings?.connections.find((connection) => connection.provider === provider)
        ?.configured,
    );

  const hasConfiguredProvider =
    isProviderConfigured('github') || isProviderConfigured('gitee');

  const openCreateProductModal = () => {
    form.resetFields();
    form.setFieldsValue({
      repositoryProvider: isProviderConfigured('github') ? 'github' : 'gitee',
    });
    setIsCreateModalOpen(true);
  };

  const saveDefaultBranch = async (values: { defaultBranch: string }) => {
    setIsSavingBranch(true);

    try {
      const savedSettings = await window.releaseHub.settings.updateDefaultBranch(
        values.defaultBranch,
      );
      setSettings(savedSettings);
      messageApi.success('默认分支已保存');
    } catch (error) {
      const description = readableErrorMessage(error, '请检查分支名称后重试');
      messageApi.error(`保存默认分支失败：${description}`);
    } finally {
      setIsSavingBranch(false);
    }
  };

  const verifyAndSaveToken = async (provider: RepositoryProvider) => {
    const token = tokens[provider]?.trim();
    if (!token) {
      messageApi.warning('请输入 Token 后再验证');
      return;
    }

    setVerifyingProvider(provider);
    try {
      const savedSettings = await window.releaseHub.settings.verifyAndSaveToken(
        provider,
        token,
      );
      setSettings(savedSettings);
      setTokens(
        Object.fromEntries(
          savedSettings.connections
            .filter((connection) => connection.token)
            .map((connection) => [connection.provider, connection.token]),
        ),
      );
      messageApi.success(`${provider === 'github' ? 'GitHub' : 'Gitee'} Token 验证成功`);
    } catch (error) {
      const description = readableErrorMessage(error, '请稍后重试');
      messageApi.error(`Token 验证失败：${description}`);
    } finally {
      setVerifyingProvider(null);
    }
  };

  const closeCreateProductModal = () => {
    setIsCreateModalOpen(false);
  };

  const openEditProductModal = (product: Product) => {
    setEditingProduct(product);
    editForm.setFieldsValue({
      name: product.name,
      description: product.description,
    });
  };

  const closeEditProductModal = () => {
    setEditingProduct(null);
    editForm.resetFields();
  };

  const openVersionManagement = (product: Product) => {
    setVersionProduct(product);
    setActivePage('versions');
  };

  useEffect(() => {
    if (!versionProduct) return;
    const productId = versionProduct.id;
    let active = true;
    setReleases([]);
    setReleaseLoadError('');
    setIsLoadingReleases(true);
    void window.releaseHub.releases.list(productId)
      .then((items) => { if (active) setReleases(items); })
      .catch((error) => { if (active) setReleaseLoadError(readableErrorMessage(error, '读取历史失败')); })
      .finally(() => { if (active) setIsLoadingReleases(false); });
    const unsubscribe = window.releaseHub.releases.onProgress((event) => {
      if (event.productId !== productId) return;
      if (event.operation === 'publish') setPublishProgress(event.message);
      else setVerifyProgress(event.message);
    });
    return () => { active = false; unsubscribe(); };
  }, [versionProduct?.id]);

  const openDownloadVerification = async () => {
    if (!versionProduct) return;
    setIsVerifyOpen(true);
    setPublicUpdate(null);
    setVerification(null);
    setVerifyError('');
    setVerifyProgress('');
    setIsLoadingUpdate(true);
    try {
      const update = await window.releaseHub.releases.getPublicUpdate(versionProduct.id);
      setPublicUpdate(update);
      setVerifyTarget(targetKey(update.assets[0]));
    } catch (error) {
      setVerifyError(readableErrorMessage(error, '读取公开更新清单失败'));
    } finally { setIsLoadingUpdate(false); }
  };

  const verifyClientDownload = async () => {
    if (!versionProduct || !publicUpdate || isVerifyingDownload) return;
    const asset = publicUpdate.assets.find((item) => targetKey(item) === verifyTarget);
    if (!asset) return;
    setIsVerifyingDownload(true);
    setVerifyError('');
    setVerification(null);
    setVerifyProgress('读取更新清单');
    try {
      const result = await window.releaseHub.releases.verifyDownload({
        productId: versionProduct.id, version: publicUpdate.version,
        platform: asset.platform, architecture: asset.architecture, packageType: asset.packageType,
      });
      setVerification(result);
    } catch (error) { setVerifyError(readableErrorMessage(error, '下载校验失败')); }
    finally { setIsVerifyingDownload(false); }
  };

  const returnToProducts = () => {
    setActivePage('products');
    setVersionProduct(null);
    setIsPublishVersionModalOpen(false);
  };

  const openPublishVersionModal = () => {
    setPublishError('');
    setPublishProgress('');
    setDraftAssets([createDraftAsset(Date.now())]);
    publishForm.resetFields();
    publishForm.setFieldsValue({ channel: 'stable' });
    setIsPublishVersionModalOpen(true);
  };

  const selectDraftFile = async (id: number) => {
    setIsSelectingFile(true);
    try {
      const file = await window.releaseHub.releases.selectFile();
      if (!file) return;
      const extension = file.fileName.split('.').pop()?.toLowerCase();
      const asset = draftAssets.find((item) => item.id === id);
      if (!asset) return;
      if (extension === 'apk') {
        updateDraftAsset(id, { file, platform: 'android', architecture: asset.platform === 'android' ? asset.architecture : 'universal', packageType: 'apk' });
      } else if (extension === 'dmg' || extension === 'pkg') {
        updateDraftAsset(id, { file, platform: 'macos', architecture: asset.platform === 'macos' ? asset.architecture : 'arm64', packageType: extension });
      } else if (extension === 'exe' || extension === 'msi') {
        updateDraftAsset(id, { file, platform: 'windows', architecture: asset.platform === 'windows' ? asset.architecture : 'x64', packageType: extension });
      } else {
        updateDraftAsset(id, { file, ...(extension === 'zip' && asset.platform !== 'android' ? { packageType: 'zip' } : {}) });
      }
    } catch (error) { messageApi.error(readableErrorMessage(error, '文件选择失败')); }
    finally { setIsSelectingFile(false); }
  };

  const publishVersion = async (values: { version: string; notes?: string; channel: 'stable' }) => {
    if (publishingRef.current || isSelectingFile) return;
    if (!versionProduct || draftAssets.some((asset) => !asset.file)) {
      setPublishError('请为每个构建产物选择文件');
      return;
    }
    setPublishError('');
    try {
      const input = validatePublishInput({
        productId: versionProduct.id, version: values.version, notes: values.notes, channel: 'stable',
        assets: draftAssets.map((asset) => ({
          filePath: asset.file!.filePath, fileName: asset.file!.fileName,
          platform: asset.platform, architecture: asset.architecture, packageType: asset.packageType,
        })),
      });
      publishingRef.current = true;
      setIsPublishing(true);
      setPublishProgress('校验发布信息');
      const release = await window.releaseHub.releases.publish(input);
      setReleases((items) => [release, ...items]);
      setIsPublishVersionModalOpen(false);
      setProducts((items) => items.map((product) => product.id === release.productId
        ? { ...product, currentVersion: release.version } : product));
      messageApi.success(`版本 ${release.version} 已发布，可使用“校验客户端下载”验证附件`);
    } catch (error) { setPublishError(readableErrorMessage(error, '发布失败，请稍后重试')); }
    finally { publishingRef.current = false; setIsPublishing(false); }
  };

  const updateDraftAsset = (
    id: number,
    changes: Partial<Omit<DraftAsset, 'id'>>,
  ) => {
    setDraftAssets((assets) =>
      assets.map((asset) => ({
        ...asset,
        ...(asset.id === id ? changes : {}),
      })),
    );
  };

  const changeDraftAssetPlatform = (id: number, platform: BuildPlatform) => {
    const target = buildTargetOptions[platform];
    updateDraftAsset(id, {
      platform,
      architecture: target.architectures[0].value,
      packageType: target.packageTypes[0].value,
    });
  };

  const addDraftAsset = () => {
    if (draftAssets.length >= 20) return;
    setDraftAssets((assets) => [
      ...assets,
      createDraftAsset(Date.now() + assets.length),
    ]);
  };

  const createProduct = async (values: ProductFormValues) => {
    setIsSavingProduct(true);

    try {
      const inspection = await window.releaseHub.products.inspectRepository(values);

      if (inspection.state === 'needs-initialization') {
        setIsSavingProduct(false);
        const confirmed = await new Promise<boolean>((resolve) => {
          Modal.confirm({
            title: '初始化 ReleaseHub 管理文件',
            content: (
              <Space direction="vertical" size={8}>
                <Typography.Paragraph style={{ marginBottom: 0 }}>
                  {inspection.message}
                </Typography.Paragraph>
                <Typography.Text type="secondary">
                  确认后仅会创建或覆盖仓库中的
                  {' '}
                  <Typography.Text code>.release-hub/manifest.json</Typography.Text>
                  ，不会修改业务代码或其他文件。
                </Typography.Text>
              </Space>
            ),
            okText: '确认初始化并创建',
            cancelText: '取消创建',
            okButtonProps: { danger: inspection.reason === 'invalid-manifest' },
            onOk: () => resolve(true),
            onCancel: () => resolve(false),
          });
        });

        if (!confirmed) {
          return;
        }

        setIsSavingProduct(true);
        await window.releaseHub.products.createWithInitialization(values);
      } else {
        await window.releaseHub.products.create(values);
      }
      await loadProducts();
      setIsCreateModalOpen(false);
      messageApi.success('产品已创建');
    } catch (error) {
      const description = readableErrorMessage(error, '请检查填写的信息后重试');
      messageApi.error(`创建产品失败：${description}`);
    } finally {
      setIsSavingProduct(false);
    }
  };

  const updateProduct = async (values: EditProductFormValues) => {
    if (!editingProduct) {
      return;
    }

    setIsSavingEdit(true);
    try {
      await window.releaseHub.products.update({
        id: editingProduct.id,
        ...values,
      });
      await loadProducts();
      closeEditProductModal();
      messageApi.success('产品信息已保存');
    } catch (error) {
      const description = readableErrorMessage(error, '请检查填写的信息后重试');
      messageApi.error(`保存产品失败：${description}`);
    } finally {
      setIsSavingEdit(false);
    }
  };

  const deleteProduct = (product: Product) => {
    Modal.confirm({
      title: '删除产品',
      content: (
        <Typography.Paragraph style={{ marginBottom: 0 }}>
          确定删除“{product.name}”吗？这会删除本地产品和版本历史，不会删除远端仓库或已发布的 Release。
        </Typography.Paragraph>
      ),
      okText: '删除产品',
      cancelText: '取消',
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await window.releaseHub.products.delete(product.id);
          await loadProducts();
          messageApi.success('产品已删除');
        } catch (error) {
          messageApi.error(`删除产品失败：${readableErrorMessage(error, '请稍后重试')}`);
        }
      },
    });
  };

  const productColumns: TableColumnsType<Product> = [
    {
      title: '产品名称',
      dataIndex: 'name',
      key: 'name',
      width: 140,
      ellipsis: true,
    },
    {
      title: '产品描述',
      dataIndex: 'description',
      key: 'description',
      width: 160,
      ellipsis: true,
      render: (description: string) => description || '—',
    },
    {
      title: '当前版本',
      dataIndex: 'currentVersion',
      key: 'currentVersion',
      width: 120,
      render: (version: string | null) => version || '暂无版本',
    },
    {
      title: '操作',
      key: 'actions',
      width: 200,
      render: (_value, product) => (
        <Space size={0} className="product-actions">
          <Button type="link" onClick={() => openEditProductModal(product)}>
            编辑
          </Button>
          <Button type="link" onClick={() => openVersionManagement(product)}>
            版本管理
          </Button>
          <Button type="link" danger onClick={() => deleteProduct(product)}>
            删除
          </Button>
        </Space>
      ),
    },
  ];

  const renderProductsPage = () => (
    <>
      <div className="page-header">
        {!hasConfiguredProvider && (
          <Typography.Text type="secondary">
            请先在设置中验证 GitHub 或 Gitee Token
          </Typography.Text>
        )}
        <Button
          type="primary"
          icon={<PlusOutlined />}
          onClick={openCreateProductModal}
          disabled={!hasConfiguredProvider}
        >
          新增产品
        </Button>
      </div>

      <Table
        className="product-table"
        columns={productColumns}
        dataSource={products}
        rowKey="id"
        pagination={false}
        scroll={{
          y: 'max(280px, min(400px, calc(100vh - 280px)))',
        }}
        locale={{
          emptyText: <Empty description="还没有产品，先创建一个吧" />,
        }}
      />
    </>
  );

  const renderSettingsPage = () => {
    const renderConnection = (provider: RepositoryProvider, label: string) => {
      const connection = settings?.connections.find(
        (item) => item.provider === provider,
      );
      const isConnected = connection?.configured;

      return (
        <Card
          className="settings-card"
          title={
            <div className="connection-card-title">
              <span>{label}</span>
              <Tag color={isConnected ? 'success' : 'default'}>
                {isConnected ? '已连接' : '未连接'}
              </Tag>
            </div>
          }
          size="small"
        >
          <Space direction="vertical" size={12} className="settings-card-content">
            <div className="connection-account">
              {isConnected ? `已验证账号：${connection?.accountLogin}` : '尚未验证 Token'}
            </div>
            <Typography.Text className="token-field-label">访问令牌</Typography.Text>
            <Input.Password
              value={tokens[provider] || ''}
              placeholder={`请输入 ${label} Token`}
              onChange={(event) =>
                setTokens((currentTokens) => ({
                  ...currentTokens,
                  [provider]: event.target.value,
                }))
              }
            />
            <Button
              type="primary"
              loading={verifyingProvider === provider}
              onClick={() => void verifyAndSaveToken(provider)}
            >
              验证并保存
            </Button>
            <Typography.Text type="secondary" className="connection-hint">
              {isConnected && connection?.verifiedAt
                ? `最近验证：${new Date(connection.verifiedAt).toLocaleString()}`
                : '验证成功后才会保存 Token。'}
            </Typography.Text>
          </Space>
        </Card>
      );
    };

    return (
      <div className="settings-page">
        <Space direction="vertical" size={20} className="settings-stack">
          <Card className="branch-settings-card" title="默认发布分支" size="small">
            <Form
              form={settingsForm}
              layout="inline"
              onFinish={saveDefaultBranch}
            >
              <Form.Item
                name="defaultBranch"
                rules={[{ required: true, message: '请输入默认分支' }]}
              >
                <Input placeholder="例如：main" />
              </Form.Item>
              <Form.Item>
                <Button
                  type="primary"
                  htmlType="submit"
                  loading={isSavingBranch}
                >
                  保存
                </Button>
              </Form.Item>
            </Form>
          </Card>
          <Card className="provider-settings-card" title="代码托管平台" size="small">
            <div className="connection-cards">
              {renderConnection('github', 'GitHub')}
              {renderConnection('gitee', 'Gitee')}
            </div>
          </Card>
        </Space>
      </div>
    );
  };

  const renderVersionsPage = () => {
    if (!versionProduct) {
      return null;
    }

    return (
      <div className="version-page">
        <div className="version-page-actions">
          <Button icon={<ArrowLeftOutlined />} onClick={returnToProducts}>
            返回产品
          </Button>
          <Button
            type="primary"
            icon={<CloudUploadOutlined />}
            onClick={openPublishVersionModal}
          >
            发布新版本
          </Button>
          <Button onClick={() => void openDownloadVerification()}>校验客户端下载</Button>
        </div>

        <Typography.Paragraph type="secondary" className="release-history-hint">
          历史记录保存在本机；删除产品或更换设备后不会自动恢复。
        </Typography.Paragraph>
        {releaseLoadError && <Alert type="error" showIcon title={releaseLoadError} />}
        <Table
          className="version-history-table"
          loading={isLoadingReleases}
          rowKey="version"
          pagination={false}
          scroll={{
            y: 'max(280px, min(400px, calc(100vh - 280px)))',
          }}
          columns={[
            { title: '版本号', dataIndex: 'version', key: 'version', width: 140 },
            { title: '构建产物', dataIndex: 'assets', key: 'assets', render: (assets: ProductRelease['assets']) => assets.map((asset) => `${asset.platform}/${asset.architecture}/${asset.packageType}`).join('，') },
            { title: '更新说明', dataIndex: 'notes', key: 'notes', width: 260 },
            { title: '发布时间', dataIndex: 'publishedAt', key: 'publishedAt', width: 180, render: (value: number) => new Date(value).toLocaleString() },
          ]}
          dataSource={releases}
          locale={{
            emptyText: (
              <Empty
                description="还没有发布版本"
                image={Empty.PRESENTED_IMAGE_SIMPLE}
              >
                <Button type="primary" onClick={openPublishVersionModal}>
                  发布第一个版本
                </Button>
              </Empty>
            ),
          }}
        />
      </div>
    );
  };

  return (
    <ConfigProvider
      theme={{
        token: {
          colorPrimary: '#2F855A',
          borderRadius: 8,
          fontFamily:
            '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        },
        components: {
          Menu: {
            itemActiveBg: '#E8F5EC',
            itemHoverBg: '#F0F9F3',
            itemSelectedBg: '#E1F3E7',
            itemSelectedColor: '#2F855A',
          },
        },
      }}
    >
      {messageContextHolder}
      <Layout className="app-layout">
        <Layout.Sider
          className="app-sider"
          width={200}
          theme="light"
          collapsedWidth={64}
          breakpoint="md"
        >
          <Menu
            mode="inline"
            disabled={isPublishing || isVerifyingDownload || isSelectingFile}
            selectedKeys={[activePage === 'versions' ? 'products' : activePage]}
            items={menuItems}
            onClick={({ key }) => {
              setActivePage(key as PageKey);
              if (key === 'products') {
                setVersionProduct(null);
              }
            }}
          />
        </Layout.Sider>

        <Layout.Content className="app-content">
          {activePage === 'products' && renderProductsPage()}
          {activePage === 'settings' && renderSettingsPage()}
          {activePage === 'versions' && renderVersionsPage()}
        </Layout.Content>
      </Layout>

      <Modal
        className="create-product-modal"
        title="新增产品"
        open={isCreateModalOpen}
        centered
        width={460}
        okText="创建产品"
        cancelText="取消"
        confirmLoading={isSavingProduct}
        onCancel={closeCreateProductModal}
        onOk={() => form.submit()}
        destroyOnHidden
      >
        <Form<ProductFormValues>
          form={form}
          layout="vertical"
          requiredMark={false}
          onFinish={createProduct}
        >
          <Form.Item
            label="产品名称"
            name="name"
            rules={[{ required: true, message: '请输入产品名称' }]}
          >
            <Input autoFocus placeholder="例如：Release Hub Desktop" />
          </Form.Item>

          <Form.Item label="产品描述" name="description">
            <Input.TextArea
              placeholder="简要说明这个产品的用途"
              autoSize={{ minRows: 3, maxRows: 5 }}
            />
          </Form.Item>

          <Form.Item
            label="代码托管平台"
            name="repositoryProvider"
            rules={[{ required: true, message: '请选择代码托管平台' }]}
          >
            <Radio.Group>
              <Radio value="github" disabled={!isProviderConfigured('github')}>
                GitHub
              </Radio>
              <Radio value="gitee" disabled={!isProviderConfigured('gitee')}>
                Gitee
              </Radio>
            </Radio.Group>
          </Form.Item>

          <Form.Item
            label="仓库地址"
            name="repositoryUrl"
            rules={[{ required: true, message: '请输入仓库地址' }]}
          >
            <Input placeholder="例如：https://github.com/owner/repository" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        className="create-product-modal"
        title="编辑产品"
        open={Boolean(editingProduct)}
        centered
        width={460}
        okText="保存更改"
        cancelText="取消"
        confirmLoading={isSavingEdit}
        onCancel={closeEditProductModal}
        onOk={() => editForm.submit()}
        destroyOnHidden
      >
        <Form<EditProductFormValues>
          form={editForm}
          layout="vertical"
          requiredMark={false}
          onFinish={updateProduct}
        >
          <Form.Item
            label="产品名称"
            name="name"
            rules={[{ required: true, message: '请输入产品名称' }]}
          >
            <Input autoFocus />
          </Form.Item>

          <Form.Item label="产品描述" name="description">
            <Input.TextArea autoSize={{ minRows: 3, maxRows: 5 }} />
          </Form.Item>

          <Form.Item label="代码托管平台">
            <Input
              value={editingProduct?.repositoryProvider === 'github' ? 'GitHub' : 'Gitee'}
              disabled
            />
          </Form.Item>

          <Form.Item label="仓库地址">
            <Input value={editingProduct?.repositoryUrl} disabled />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        className="publish-version-modal"
        title="发布新版本"
        open={isPublishVersionModalOpen}
        centered
        width={660}
        okText="发布版本"
        cancelText="取消"
        onCancel={() => { if (!isPublishing && !isSelectingFile) setIsPublishVersionModalOpen(false); }}
        closable={!isPublishing && !isSelectingFile}
        keyboard={!isPublishing && !isSelectingFile}
        cancelButtonProps={{ disabled: isPublishing || isSelectingFile }}
        okButtonProps={{ disabled: isSelectingFile }}
        confirmLoading={isPublishing}
        onOk={() => publishForm.submit()}
        destroyOnHidden
      >
        {isPublishing && <Alert className="release-feedback" type="info" showIcon title={publishProgress || '正在发布'} />}
        {publishError && <Alert className="release-feedback" type="error" showIcon title="发布未完成" description={<span className="release-error-detail">{publishError}</span>} />}
        <Form form={publishForm} disabled={isPublishing || isSelectingFile} layout="vertical" requiredMark={false} onFinish={publishVersion}>
          <div className="publish-version-basics">
            <Form.Item name="version"
              label="版本号"
              rules={[{ validator: (_rule, value) => {
                try { stableVersion(value); return Promise.resolve(); }
                catch (error) { return Promise.reject(error); }
              } }]}
              className="publish-version-number"
            >
              <Input placeholder="例如：1.2.0" />
            </Form.Item>
            <Form.Item name="channel" label="发布渠道" className="publish-version-channel">
              <Select options={[{ value: 'stable', label: '稳定版（stable）' }]} />
            </Form.Item>
          </div>
          <Form.Item name="notes" label="更新说明">
            <Input.TextArea
              placeholder="说明本次版本的新增功能、修复内容或注意事项"
              autoSize={{ minRows: 3, maxRows: 5 }}
            />
          </Form.Item>

          <div className="asset-section-header">
            <div>
              <Typography.Text strong>构建产物</Typography.Text>
              <Typography.Text type="secondary" className="asset-section-hint">
                请确认平台、架构与后缀；文件名无法自动识别真实架构。Android 仅支持 APK。
              </Typography.Text>
            </div>
            <Button
              type="link"
              icon={<PlusOutlined />}
              onClick={addDraftAsset}
              disabled={isPublishing || isSelectingFile || draftAssets.length >= 20}
            >
              添加构建产物
            </Button>
          </div>

          <div className="draft-assets">
            {draftAssets.map((asset) => {
              const target = buildTargetOptions[asset.platform];

              return (
              <div className="draft-asset" key={asset.id}>
                <Button className="asset-file-button" title={asset.file ? `${asset.file.fileName}（${(asset.file.size / 1024 / 1024).toFixed(1)} MB）` : '选择文件'} onClick={() => void selectDraftFile(asset.id)}>{asset.file?.fileName || '选择文件'}</Button>
                <Select
                  value={asset.platform}
                  options={(Object.keys(buildTargetOptions) as BuildPlatform[]).map(
                    (platform) => ({
                      value: platform,
                      label: buildTargetOptions[platform].label,
                    }),
                  )}
                  onChange={(platform: BuildPlatform) =>
                    changeDraftAssetPlatform(asset.id, platform)
                  }
                />
                <Select
                  value={asset.architecture}
                  options={target.architectures}
                  onChange={(architecture: string) =>
                    updateDraftAsset(asset.id, { architecture })
                  }
                />
                <Select
                  value={asset.packageType}
                  options={target.packageTypes}
                  onChange={(packageType: string) =>
                    updateDraftAsset(asset.id, { packageType })
                  }
                />
                {draftAssets.length > 1 && (
                  <Button
                    type="text"
                    danger
                    onClick={() =>
                      setDraftAssets((assets) =>
                        assets.filter((item) => item.id !== asset.id),
                      )
                    }
                  >
                    删除
                  </Button>
                )}
              </div>
              );
            })}
          </div>
        </Form>
      </Modal>
      <Modal
        title="校验客户端下载"
        open={isVerifyOpen}
        centered
        width={560}
        okText={isVerifyingDownload ? '下载校验中' : '开始校验'}
        cancelText="关闭"
        confirmLoading={isVerifyingDownload}
        okButtonProps={{ disabled: isLoadingUpdate || !publicUpdate }}
        cancelButtonProps={{ disabled: isVerifyingDownload || isLoadingUpdate }}
        closable={!isVerifyingDownload && !isLoadingUpdate}
        keyboard={!isVerifyingDownload && !isLoadingUpdate}
        onCancel={() => { if (!isVerifyingDownload && !isLoadingUpdate) setIsVerifyOpen(false); }}
        onOk={() => void verifyClientDownload()}
      >
        <Typography.Paragraph type="secondary">
          模拟客户端，不使用 Token 读取最新版和下载文件；校验后不保留安装包，不会安装。
        </Typography.Paragraph>
        {isLoadingUpdate && <Alert type="info" title="正在读取公开更新清单…" />}
        {publicUpdate && (
          <Form layout="vertical">
            <Form.Item label={`最新稳定版：${publicUpdate.version} · 选择客户端目标`}>
              <Select
                style={{ width: '100%' }}
                disabled={isVerifyingDownload}
                value={verifyTarget}
                options={publicUpdate.assets.map((asset) => ({ value: targetKey(asset), label: `${targetKey(asset)} · ${asset.fileName}` }))}
                onChange={(value) => { setVerifyTarget(value); setVerification(null); setVerifyError(''); setVerifyProgress(''); }}
              />
            </Form.Item>
          </Form>
        )}
        {isVerifyingDownload && <Alert type="info" showIcon title={verifyProgress} />}
        {verifyError && <Alert type="error" showIcon title="校验未通过" description={verifyError} />}
        {verification && <Alert type="success" showIcon title="下载与 SHA-256 校验通过" description={
          <div className="release-error-detail">
            <div>{verification.fileName} · {verification.size.toLocaleString()} 字节</div>
            <div>SHA-256：{verification.sha256}</div>
          </div>
        } />}
      </Modal>
    </ConfigProvider>
  );
}

export default App;
