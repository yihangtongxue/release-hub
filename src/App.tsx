import {
  AppstoreOutlined,
  PlusOutlined,
  SettingOutlined,
} from '@ant-design/icons';
import {
  Button,
  ConfigProvider,
  Empty,
  Form,
  Input,
  Layout,
  Menu,
  message,
  Modal,
  Radio,
  Table,
  Typography,
} from 'antd';
import type { MenuProps, TableColumnsType } from 'antd';
import { useEffect, useState } from 'react';

import type { CreateProductInput, Product } from './shared/product';

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
  const [form] = Form.useForm<ProductFormValues>();
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

  useEffect(() => {
    void loadProducts();
  }, [messageApi]);

  const openCreateProductModal = () => {
    form.resetFields();
    setIsCreateModalOpen(true);
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
        <Button
          type="primary"
          icon={<PlusOutlined />}
          onClick={openCreateProductModal}
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

  const renderSettingsPage = () => (
    <div className="settings-placeholder">
      <Typography.Title level={2}>设置</Typography.Title>
      <Typography.Paragraph type="secondary">
        GitHub、Gitee 仓库连接和本地数据管理将在这里配置。
      </Typography.Paragraph>
    </div>
  );

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
          initialValues={{ repositoryProvider: 'github' }}
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
              <Radio value="github">GitHub</Radio>
              <Radio value="gitee">Gitee</Radio>
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
