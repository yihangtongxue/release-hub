# ReleaseHub

ReleaseHub 是一个桌面端发布控制台，用于把应用构建产物、版本号和更新说明发布到 GitHub、Gitee 或 CNB 仓库的 Release 中，并生成供客户端检查更新的公开清单。

它只负责管理和发布；客户端自行决定何时检查更新、如何下载、校验、安装和回滚。

## 当前 MVP 可用功能

- 管理多个产品：新增、编辑名称与描述、配置产品级签名策略和应用标识、删除本地产品记录。
- 绑定 GitHub、Gitee 或 CNB 仓库；创建产品时检查仓库是否已由 ReleaseHub 管理。
- 初始化仓库所需的 `.release-hub/manifest.json`，只会创建或覆盖该管理文件，不会删除业务文件。
- 设置新产品发布分支；创建时不存在该分支会从仓库默认分支创建，保存、回显、显示/隐藏 GitHub、Gitee 与 CNB Token；保存前验证 Token 是否可用。
- 发布稳定版：版本号、更新说明和最多 20 个构建产物。
- 支持 macOS（DMG / PKG / ZIP）、Windows（EXE / MSI / ZIP）、Android（APK）及对应架构选择。
- 发布前校验文件非空、文件名和后缀、重复文件名、重复构建目标、版本格式以及本地/远端版本冲突。
- 同版本已存在时提示确认覆盖；确认后替换该版本的 Release、全部附件、客户端清单和本地记录，仍然禁止发布低于已有版本的版本。
- 创建远端 Release、上传附件，并写入 `.release-hub/updates/stable.json` 更新清单。
- 本机保存产品与版本历史；产品列表展示当前版本。
- “校验客户端下载”：匿名读取远端清单、下载指定目标附件，核对文件大小和 SHA-256；不会安装或保留附件。
- 发布或下载校验期间显示阶段进度，阻止重复提交、删除产品和普通关闭窗口。

## 当前限制

- 仅支持公开仓库和稳定版三段数字版本号，例如 `1.2.0`。
- 每次发布的清单只包含本次选择的附件；如果同一版本需要 macOS、Windows、Android，应一次性选齐。
- 附件大小会在选择文件后提示，并在修改远端前读取实际文件重新校验。Gitee 按接口返回的 100 MB 限制保守预检（100,000,000 字节）；GitHub 单个附件必须小于 2 GiB；CNB 本地保守预检要求小于 5 GB（5,000,000,000 字节）。预检不能解除平台的大小、配额或权限限制。
- 版本历史是本机数据，不会自动同步完整远端历史。
- 不支持私有仓库客户端鉴权、灰度发布、预发布版本、断点续传、自动回滚和多用户发布锁。
- 发布中断时可能留下远端 Release 或标签，可重新发布同版本并确认覆盖。GitHub/Gitee/CNB 均按整个同版本 Release 删除重建，附件使用原始文件名，仅保留本次选择的附件；期间下载可能中断，失败后不自动回滚。已有 Git 标签保持不变。

## 发布前准备

1. 在 GitHub、Gitee 或 CNB 创建一个公开仓库。
2. 在 ReleaseHub 的“设置”中填写并验证对应平台 Token，设置新产品发布分支。
3. 新增产品并填写仓库地址。若指定发布分支不存在，ReleaseHub 会从仓库默认分支创建它；空仓库则直接在指定分支初始化。尚未初始化的仓库会要求确认创建 ReleaseHub 管理文件。
4. 进入“版本管理”，选择构建产物并发布版本。
5. 发布后使用“校验客户端下载”确认无需 Token 的客户端可以下载并通过 SHA-256 校验。

## 客户端更新协议

客户端从产品仓库读取稳定版清单：

```text
.release-hub/updates/stable.json
```

GitHub Contents API：

```text
https://api.github.com/repos/{owner}/{repo}/contents/.release-hub/updates/stable.json?ref={branch}
```

Gitee Contents API：

```text
https://gitee.com/api/v5/repos/{owner}/{repo}/contents/.release-hub/updates/stable.json?ref={branch}
```

CNB 公开原始文件地址（支持多级组织路径，直接返回 JSON）：

```text
https://cnb.cool/{组织路径}/{仓库}/-/git/raw/{branch}/.release-hub/updates/stable.json
```

CNB 配置步骤、免费额度边界及人工验收见 [CNB 接入](docs/CNB接入.md)。本次新增 `isomorphic-git` 依赖，开发环境需要先安装更新后的依赖。

GitHub/Gitee Contents API 返回的 `content` 是 Base64，需要解码为 JSON；CNB 公开 raw 地址直接读取 JSON。CNB 管理 OpenAPI 需要认证，不能作为匿名客户端入口。客户端不应携带发布 Token。

清单主要字段：

```json
{
  "schemaVersion": 1,
  "channel": "stable",
  "version": "1.2.0",
  "tag": "v1.2.0",
  "publishedAt": 0,
  "notes": "更新说明",
  "assets": [
    {
      "fileName": "ReleaseHub-1.2.0-arm64.dmg",
      "platform": "macos",
      "architecture": "arm64",
      "packageType": "dmg",
      "size": 123456,
      "sha256": "...",
      "downloadUrl": "https://..."
    }
  ]
}
```

`{branch}` 必须是创建产品时设置的发布分支，不能写死为 `main` 或改为读取仓库默认分支。客户端应按 `platform`、`architecture`、`packageType` 精确选择附件；比较三段数字版本号；下载后确认 `size` 与 `sha256` 后，再交给自身的安装流程。SHA-256 用于完整性核对，不替代应用安装包签名。

更完整的手动验收项和失败处理说明见 [MVP 验收与客户端接入](docs/MVP验收与客户端接入.md)。

通用更新包签名接入见 [更新包签名](docs/更新包签名.md)：每个产品选择“签名可选”或“必须签名”，配置与客户端一致的应用标识；ReleaseHub 在上传前验证安装包旁的 `.sig.json` 并透传签名，不读取私钥，不按仓库地址判断产品。

升级后的旧产品需要在“编辑产品”中确认一次签名策略，再发布新版本；历史版本和下载校验不受影响。签名配置保存在本机，重新添加产品或更换设备时需要重新配置。
