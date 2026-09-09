import {
  AppstoreOutlined,
  ArrowLeftOutlined,
  CloudUploadOutlined,
  PlusOutlined,
  SettingOutlined,
} from '@ant-design/icons';
import {
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
import { useEffect, useState } from 'react';

import type {
  AppSettings,
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
type BuildPlatform = 'macos' | 'windows' | 'android';

interface DraftAsset {
  id: number;
  platform: BuildPlatform;
  architecture: string;
  packageType: string;
  file: SelectedBuildFile | null;
}

const buildTargetOptions: Record<
  BuildPlatform,
  {
    label: string;
    architectures: Array<{ value: string; label: string }>;
    packageTypes: Array<{ value: string; label: string }>;
  }
> = {
  macos: {
    label: 'macOS',
    architectures: [
      { value: 'arm64', label: 'Apple Silicon（arm64）' },
      { value: 'x64', label: 'Intel（x64）' },
      { value: 'universal', label: '通用（universal）' },
    ],
    packageTypes: [
      { value: 'dmg', label: 'DMG' },
      { value: 'pkg', label: 'PKG' },
      { value: 'zip', label: 'ZIP' },
    ],
  },
  windows: {
    label: 'Windows',
    architectures: [
      { value: 'x64', label: 'x64' },
      { value: 'arm64', label: 'arm64' },
    ],
    packageTypes: [
      { value: 'exe', label: 'EXE' },
      { value: 'msi', label: 'MSI' },
      { value: 'zip', label: 'ZIP' },
    ],
  },
  android: {
    label: 'Android',
    architectures: [
      { value: 'arm64-v8a', label: 'arm64-v8a' },
      { value: 'armeabi-v7a', label: 'armeabi-v7a' },
      { value: 'x86_64', label: 'x86_64' },
      { value: 'universal', label: '通用 APK' },
    ],
    packageTypes: [
      { value: 'apk', label: 'APK' },
      { value: 'aab', label: 'AAB' },
    ],
  },
};

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
      setTokens((currentTokens) => ({ ...currentTokens, [provider]: '' }));
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
    void window.releaseHub.releases.list(product.id).then(setReleases);
  };

  const returnToProducts = () => {
    setActivePage('products');
    setVersionProduct(null);
    setIsPublishVersionModalOpen(false);
  };

  const openPublishVersionModal = () => {
    setDraftAssets([createDraftAsset(Date.now())]);
    publishForm.resetFields();
    publishForm.setFieldsValue({ channel: 'stable' });
    setIsPublishVersionModalOpen(true);
  };

  const selectDraftFile = async (id: number) => {
    const file = await window.releaseHub.releases.selectFile();
    if (file) updateDraftAsset(id, { file });
  };

  const publishVersion = async (values: { version: string; notes?: string; channel: 'stable' }) => {
    if (!versionProduct || draftAssets.some((asset) => !asset.file)) { messageApi.warning('请为每个构建产物选择文件'); return; }
    setIsPublishing(true);
    try {
      const release = await window.releaseHub.releases.publish({ productId: versionProduct.id, version: values.version, notes: values.notes, channel: 'stable', assets: draftAssets.map((asset) => ({ filePath: asset.file!.filePath, fileName: asset.file!.fileName, platform: asset.platform, architecture: asset.architecture, packageType: asset.packageType })) });
      setReleases((items) => [release, ...items]);
      setIsPublishVersionModalOpen(false);
      await loadProducts();
      messageApi.success(`版本 ${release.version} 已发布`);
    } catch (error) { messageApi.error(`发布失败：${readableErrorMessage(error, '请稍后重试')}`); }
    finally { setIsPublishing(false); }
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
        <Card className="settings-card" title={label} size="small">
          <Space direction="vertical" size={12} className="settings-card-content">
            <div className="connection-status">
              <Tag color={isConnected ? 'success' : 'default'}>
                {isConnected ? '已连接' : '未连接'}
              </Tag>
              {isConnected && <span>{connection?.accountLogin}</span>}
            </div>
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
        <Typography.Title level={2}>设置</Typography.Title>
        <Space direction="vertical" size={20} className="settings-stack">
          <Card title="默认发布分支" size="small">
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
          <div className="connection-cards">
            {renderConnection('github', 'GitHub')}
            {renderConnection('gitee', 'Gitee')}
          </div>
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
        </div>

        <Table
          className="version-history-table"
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
        onCancel={() => setIsPublishVersionModalOpen(false)}
        confirmLoading={isPublishing}
        onOk={() => publishForm.submit()}
        destroyOnHidden
      >
        <Form form={publishForm} layout="vertical" requiredMark={false} onFinish={publishVersion}>
          <div className="publish-version-basics">
            <Form.Item name="version"
              label="版本号"
              rules={[{ required: true, message: '请输入版本号' }]}
              className="publish-version-number"
            >
              <Input placeholder="例如：1.2.0" />
            </Form.Item>
            <Form.Item name="channel" label="发布渠道" className="publish-version-channel">
              <Select defaultValue="stable" options={[{ value: 'stable', label: '稳定版（stable）' }]} />
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
                每个文件都要标注目标平台、架构和包类型。
              </Typography.Text>
            </div>
            <Button
              type="link"
              icon={<PlusOutlined />}
              onClick={addDraftAsset}
            >
              添加构建产物
            </Button>
          </div>

          <div className="draft-assets">
            {draftAssets.map((asset) => {
              const target = buildTargetOptions[asset.platform];

              return (
              <div className="draft-asset" key={asset.id}>
                <Button onClick={() => void selectDraftFile(asset.id)}>{asset.file?.fileName || '选择文件'}</Button>
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
    </ConfigProvider>
  );
}

export default App;
