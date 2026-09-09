import {
  AppstoreOutlined,
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
  RepositoryProvider,
} from './shared/product';

type PageKey = 'products' | 'settings';
type ProductFormValues = CreateProductInput;

const menuItems: MenuProps['items'] = [
  { key: 'products', icon: <AppstoreOutlined />, label: '产品' },
  { key: 'settings', icon: <SettingOutlined />, label: '设置' },
];

const productColumns: TableColumnsType<Product> = [
  { title: '产品名称', dataIndex: 'name', key: 'name', width: 220 },
  {
    title: '产品描述',
    dataIndex: 'description',
    key: 'description',
    render: (description: string) => description || '—',
  },
  {
    title: '当前版本',
    dataIndex: 'currentVersion',
    key: 'currentVersion',
    width: 160,
    render: (version: string | null) => version || '暂无版本',
  },
  {
    title: '操作',
    key: 'actions',
    width: 180,
    render: () => (
      <>
        <Button type="link">编辑</Button>
        <Button type="link">版本管理</Button>
      </>
    ),
  },
];

function App() {
  const [activePage, setActivePage] = useState<PageKey>('products');
  const [products, setProducts] = useState<Product[]>([]);
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [isSavingProduct, setIsSavingProduct] = useState(false);
  const [isSavingBranch, setIsSavingBranch] = useState(false);
  const [verifyingProvider, setVerifyingProvider] =
    useState<RepositoryProvider | null>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [tokens, setTokens] = useState<
    Partial<Record<RepositoryProvider, string>>
  >({});
  const [form] = Form.useForm<ProductFormValues>();
  const [settingsForm] = Form.useForm<{ defaultBranch: string }>();
  const [messageApi, messageContextHolder] = message.useMessage();

  const loadProducts = async () => {
    try {
      const savedProducts = await window.releaseHub.products.list();
      setProducts(savedProducts);
    } catch (error) {
      const description =
        error instanceof Error ? error.message : '请稍后重试';
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
      const description =
        error instanceof Error ? error.message : '请稍后重试';
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
      const description =
        error instanceof Error ? error.message : '请检查分支名称后重试';
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
      const description =
        error instanceof Error ? error.message : '请稍后重试';
      messageApi.error(`Token 验证失败：${description}`);
    } finally {
      setVerifyingProvider(null);
    }
  };

  const closeCreateProductModal = () => {
    setIsCreateModalOpen(false);
  };

  const createProduct = async (values: ProductFormValues) => {
    setIsSavingProduct(true);

    try {
      await window.releaseHub.products.create(values);
      await loadProducts();
      setIsCreateModalOpen(false);
      messageApi.success('产品已创建');
    } catch (error) {
      const description =
        error instanceof Error ? error.message : '请检查填写的信息后重试';
      messageApi.error(`创建产品失败：${description}`);
    } finally {
      setIsSavingProduct(false);
    }
  };

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
          x: 720,
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
            selectedKeys={[activePage]}
            items={menuItems}
            onClick={({ key }) => setActivePage(key as PageKey)}
          />
        </Layout.Sider>

        <Layout.Content className="app-content">
          {activePage === 'products'
            ? renderProductsPage()
            : renderSettingsPage()}
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
    </ConfigProvider>
  );
}

export default App;
