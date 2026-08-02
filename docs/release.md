# 发布插件（Release with GitHub Actions）

本仓库已配置好 GitHub Actions：推送一个 tag 时，工作流会自动构建插件并创建一个 **草稿（draft）GitHub Release**，并附上 `main.js`、`manifest.json`、`styles.css` 三个必需文件。你只需在 GitHub 上补全发布说明并「Publish」即可。

> 流程参考官方文档：[Release your plugin with GitHub Actions](https://docs.obsidian.md/Plugins/Releasing/Release+your+plugin+with+GitHub+Actions)。

## 发布所需的文件

一个可被 Obsidian 识别的插件发布物必须包含：

| 文件            | 说明                                                                                 |
| --------------- | ------------------------------------------------------------------------------------ |
| `main.js`       | 构建产物（由 `npm run build` 生成，已被 `.gitignore` 忽略，只随 Release 附件分发）。 |
| `manifest.json` | 插件元信息，`version` 字段必须与发布的 tag 一致。                                    |
| `styles.css`    | 插件的样式文件（本仓库存在；若你的插件不带样式可省略）。                             |
| `versions.json` | 记录每个 `version` 对应的 `minAppVersion`（由 `npm run version` 维护）。             |

## 工作流（已存在）

工作流位于 `.github/workflows/main.yml`，核心逻辑：

```yml
name: Release Obsidian plugin

on:
  push:
    tags:
      - "*"

jobs:
  build:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v5

      - name: Use Node.js
        uses: actions/setup-node@v4
        with:
          node-version: "24"

      - name: Build plugin
        run: |
          npm install
          npm run build

      - name: Create release
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          tag="${GITHUB_REF#refs/tags/}"
          gh release create "$tag" \
            --title="$tag" \
            --draft \
            main.js manifest.json styles.css
```

> 官方模板额外包含 **Generate artifact attestation** 步骤（`actions/attest`），为发布产物生成构建来源签名（build provenance），在提交到社区插件目录时推荐启用。本仓库当前工作流未包含该步骤。若需要，可参照官方文档补上 `attestations: write` 权限与 `actions/attest@v4` 步骤。

## 发布步骤

1. **本地构建并检查类型**（提交前务必通过，避免工作流构建失败）：

   ```bash
   npm run build
   ```

2. **提升版本号**。修改 `package.json` 中的 `version`，然后执行：

   ```bash
   npm run version
   ```

   该脚本（`version-bump.mjs`）会：
   - 把 `manifest.json` 的 `version` 更新为 `package.json` 的版本；
   - 在 `versions.json` 中以该版本为键、写入 `minAppVersion`；
   - 自动 `git add manifest.json versions.json`。

3. **提交并推送改动**：

   ```bash
   git add -A
   git commit -m "Release 1.1.0"
   git push origin main
   ```

4. **创建与 `manifest.json` 中 `version` 一致的 tag 并推送**：

   ```bash
   git tag -a 1.1.0 -m "1.1.0"
   git push origin 1.1.0
   ```

   - `-a` 创建带注释的 tag；
   - tag 名必须与该次发布的版本号相同（Obsidian 据此匹配更新）。

5. 在 GitHub 仓库的 **Actions** 标签页查看工作流运行；它会构建插件并创建草稿 Release。

6. 回到仓库主页右侧的 **Releases**，工作流已生成草稿 Release，并把 `main.js`、`manifest.json`、`styles.css` 作为附件上传。

7. 点击发布名右侧的 **Edit（铅笔图标）**，填写发布说明（让用户了解本版本的变更），然后 **Publish release**。

完成。此后用户即可在 Obsidian 中更新到最新版本。

## 其他说明

- **首次发布**：发布完成后，即可按官方流程 [Submit your plugin](https://docs.obsidian.md/Plugins/Releasing/Submit+your+plugin) 将插件提交到社区插件目录。
- **Beta 发布**：官方支持用预发布（pre-release）方式发布测试版本；本仓库工作流未显式加 `--prerelease`，如需可手动在草稿 Release 上勾选「Set as a pre-release」后再发布。
- **工作流权限**：若工作流无写入权限，需在仓库 **Settings → Actions → General → Workflow permissions** 中选择 **Read and write permissions** 并保存。
- **`main.js` 不入库**：`.gitignore` 已忽略 `main.js`，它只随 GitHub Release 附件分发，不要将其提交到仓库。
