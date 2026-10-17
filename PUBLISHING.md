# 发布到 DSH 插件商城

仓库已经建好：<https://github.com/yang02li/dsh-fuzzy-memory>（空的）。
下面是把它变成「能被插件市场收录、能被别人安装」的完整步骤。

没有 git 也能做完：**网页上传**就行。npm 是可选的。

---

## 0. 先确认仓库名

打开仓库 → Settings → General → Repository name。

- 如果是 `dsh-fuzzy-memory`，跳过。
- 如果被建成了中文名（比如 `DSH-模糊-存储器`），改成 **`dsh-fuzzy-memory`** 再保存。URL、安装命令、文档都按这个名字写好了。

## 1. 把文件传到仓库（不用 git）

1. 打开 <https://github.com/yang02li/dsh-fuzzy-memory>，点页面上的 **uploading an existing file**（上传现有文件）。
2. 打开资源管理器，进入：
   `C:\Users\Administrator\Documents\deepseek-harness\default-workspace\dsh-fuzzy-memory`
3. 全选这些内容，拖进浏览器上传框：
   - `package.json`
   - `README.md`
   - `CHANGELOG.md`
   - `LICENSE`
   - `cordis.patch.yml`
   - `lib` 文件夹
   - `tools` 文件夹
   - `PUBLISHING.md`
   - `.gitignore`（看不见的话，在资源管理器「查看」里勾选「隐藏的项目」）
4. 下面 Commit message 填 `feat: dsh-fuzzy-memory 0.2.0`，点 **Commit changes**。

> 网页上传不支持空文件夹，`dist/` 本来也不该传，忽略即可。

**如果你有 git**，也可以在本目录用命令行推：

```powershell
cd C:\Users\Administrator\Documents\deepseek-harness\default-workspace\dsh-fuzzy-memory
git init
git add .
git commit -m "feat: dsh-fuzzy-memory 0.2.0"
git branch -M main
git remote add origin https://github.com/yang02li/dsh-fuzzy-memory.git
git push -u origin main
```

## 2. 加 topic（决定能不能被自动收录）

仓库首页右上 **About** 旁边的齿轮 → **Topics** → 填 `dsh-plugin` → 保存。
顺便把 Description 填成：`模糊记忆：关键词印象 + 核心档案 + 按需想起 + 会遗忘`。

## 3. 可选：发布到 npm

不发也能被收录，用户可以用 GitHub 方式安装；发了则多一种安装方式。

便携版里没有 npm CLI，但自带 pnpm：

```powershell
D:\DeepSeek-Harness-Portable-0.2.0-rc.2\tools\pnpm\pnpm.exe --version
```

先在 <https://www.npmjs.com/settings/~/tokens> 建一个 **Automation** token，然后：

```powershell
D:\DeepSeek-Harness-Portable-0.2.0-rc.2\tools\pnpm\pnpm.exe config set //registry.npmjs.org/:_authToken=你的token
D:\DeepSeek-Harness-Portable-0.2.0-rc.2\tools\pnpm\pnpm.exe publish --access public
```

注意：

- 名字 `dsh-fuzzy-memory` 若被占用，改成 `@yang02li/dsh-fuzzy-memory`，同时改 `package.json` 的 `name` 和 `cordis.patch.yml` 的 `name` 两处。
- 发布前可以先 `pnpm pack` 看包内容。

## 4. 提交给插件目录

- **自动**：带 `dsh-plugin` topic 的仓库会被 <https://dsh-plugin.org> 抓取收录，快则几小时。
- **手动**：打开 <https://dsh-plugin.org/zh/submit>，填仓库地址，分类选「记忆 / Memory」。

收录后，在 DSH 的「设置 → 插件市场」里搜 `fuzzy` 就能看到。

## 5. 用户怎么装

从 npm（如果发了）：

```bat
dsh plugin --profile web add dsh-fuzzy-memory
```

从 GitHub（没发 npm 也能用）：

```bat
dsh plugin --profile web add github:yang02li/dsh-fuzzy-memory
```

装完重启 DSH，插件默认开启。

## 6. 发版

改 `package.json` 的 `version`、在 `CHANGELOG.md` 顶部加一节，然后 `pnpm publish`；
GitHub 上打个 Release 或 tag 方便别人看变更。

## 注意事项

- 插件用了 DSH 0.2.0-rc.2 的 `agent/pre-step`、`systemPrompt`、`tools` 接口；DSH 大版本升级后要回归测试。
- 仓库不要传 `dist/`、`node_modules/`、`data/`、`*.tgz`。
- 用户记忆写在 `<DSH_HOME>\fuzzy-memory\`，README 里已写明，发布时别漏。
- `package.json` 里 author 写的是 `YYY`，仓库在 `yang02li` 名下；如果想让作者署名一致，把两处都改成你想要的显示名。
