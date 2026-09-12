import type { BuildAssetInput, BuildPlatform, PublishReleaseInput } from './product';

export const buildTargetOptions = {
  macos: {
    label: 'macOS',
    architectures: [
      { value: 'arm64', label: 'Apple Silicon（arm64）' },
      { value: 'x64', label: 'Intel（x64）' },
      { value: 'universal', label: '通用（universal）' },
    ],
    packageTypes: ['dmg', 'pkg', 'zip'].map((value) => ({ value, label: value.toUpperCase() })),
  },
  windows: {
    label: 'Windows',
    architectures: ['x64', 'arm64'].map((value) => ({ value, label: value })),
    packageTypes: ['exe', 'msi', 'zip'].map((value) => ({ value, label: value.toUpperCase() })),
  },
  android: {
    label: 'Android',
    architectures: [
      ...['arm64-v8a', 'armeabi-v7a', 'x86_64'].map((value) => ({ value, label: value })),
      { value: 'universal', label: '通用 APK' },
    ],
    // 自动更新仅分发可直接安装的 APK；AAB 属于商店分发产物。
    packageTypes: [{ value: 'apk', label: 'APK' }],
  },
};

export function stableVersion(value: unknown): string {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value.trim()) || value.length > 64) {
    throw new Error('稳定版版本号应为三段数字，例如 1.2.0；暂不支持预发布版本');
  }
  return value.trim();
}

export function compareVersions(left: string, right: string): number {
  const a = stableVersion(left).split('.').map(BigInt);
  const b = stableVersion(right).split('.').map(BigInt);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  }
  return 0;
}

export const targetKey = (asset: Pick<BuildAssetInput, 'platform' | 'architecture' | 'packageType'>): string =>
  `${asset.platform}/${asset.architecture}/${asset.packageType}`;

export function validateTarget(asset: Pick<BuildAssetInput, 'platform' | 'architecture' | 'packageType'>): void {
  const platform = asset?.platform;
  if (!['macos', 'windows', 'android'].includes(platform)) throw new Error('请选择支持的平台');
  const options = buildTargetOptions[platform as BuildPlatform];
  if (!options.architectures.some((option) => option.value === asset.architecture) ||
      !options.packageTypes.some((option) => option.value === asset.packageType)) {
    throw new Error(`${options.label} 的架构或安装包类型不匹配`);
  }
}

export function validatePublishInput(input: PublishReleaseInput): PublishReleaseInput {
  if (!input || typeof input.productId !== 'string' || !input.productId) throw new Error('请选择产品');
  const version = stableVersion(input.version);
  if (input.overwriteConfirmation !== undefined &&
      (typeof input.overwriteConfirmation !== 'string' || !/^[a-f0-9]{64}$/.test(input.overwriteConfirmation))) {
    throw new Error('覆盖确认信息无效，请重新发布并确认');
  }
  if (input.channel !== 'stable') throw new Error('当前仅支持稳定版渠道');
  if (input.notes != null && (typeof input.notes !== 'string' || input.notes.length > 20000)) throw new Error('更新说明最多 20000 个字符');
  if (!Array.isArray(input.assets) || !input.assets.length || input.assets.length > 20) throw new Error('请添加 1 至 20 个构建产物');
  const names = new Set<string>();
  const targets = new Set<string>();
  for (const asset of input.assets) {
    validateTarget(asset);
    if (typeof asset.filePath !== 'string' || !asset.filePath || typeof asset.fileName !== 'string' ||
        !asset.fileName || /[\\/\x00-\x1f]/.test(asset.fileName)) throw new Error('请重新选择有效文件');
    if (!asset.fileName.toLowerCase().endsWith(`.${asset.packageType}`)) throw new Error(`${asset.fileName} 的后缀应为 .${asset.packageType}`);
    const name = asset.fileName.toLowerCase();
    const target = targetKey(asset);
    if (names.has(name)) throw new Error(`文件名重复：${asset.fileName}`);
    if (targets.has(target)) throw new Error(`构建目标重复：${target}`);
    names.add(name);
    targets.add(target);
  }
  return { ...input, version, notes: input.notes?.trim() || '' };
}
