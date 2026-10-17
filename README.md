# dsh-fuzzy-memory

给 DeepSeek Harness 的**模糊记忆**插件。作者：**YYY**（仓库：[yang02li/dsh-fuzzy-memory](https://github.com/yang02li/dsh-fuzzy-memory)）。

它不存全文，只存「关键词 + 一句话印象」；下一次撞上相关话题时，它可能想起来，也可能想不起来；时间久了会忘。这就是设计目标——像人，而不是数据库。

> 适配 DSH `0.2.0-rc.2`（用到 `agent/pre-step`、`systemPrompt`、`tools` 接口）。DSH 大版本升级后请回归测试。

## 安装（从商城 / npm）

```bat
dsh plugin --profile web add dsh-fuzzy-memory
```

或从 GitHub：

```bat
dsh plugin --profile web add github:yang02li/dsh-fuzzy-memory
```

装完重启 DSH，插件默认开启。开关与参数在 `cordis.patch.yml` 里按 id 覆盖。

## 它做什么

| 能力 | 说明 |
|---|---|
| 随机抽取 | 你每说一句话，有 `sampleRate`（默认 35%）的概率被抽一个关键词，配一句话印象存到本地 |
| 核心档案 | 「我叫阳阳 / 我喜欢喝乌龙茶 / 我住杭州」这类显式事实单独存成 `profile`，**每段会话开头强制带上**，不靠关键词碰运气 |
| 显式记忆 | 句子里出现「记住 / 我喜欢 / 我叫 / 生日 / 下次」等触发词时，无条件记一条 |
| 模型主动记 | 提供 `fuzzy_remember` 工具，模型觉得值得记时自己调 |
| 按需想起 | 每轮对话前，用你这句话给所有记忆打分，命中一条就在对话里注入「你模糊记得：……」。分数低于阈值就什么都不注入——那就是「想不起来」 |
| 会遗忘 | 30 天没被想起，置信度打八折；低于阈值从检索里消失；库超过上限时按「可信度 × 新鲜度」淘汰 |
| 主动回忆 | 提供 `fuzzy_recall` 工具，模型想不起某事时可以翻记忆库 |
| 可选人设 | 在配置里填 `persona` 会追加到系统提示词；打开 `personaComplete` 会替换整个系统提示词（陪伴模式） |

关闭开关时，插件不注册任何东西，就是原生 DeepSeek。

## 本地开发 / 从源码安装

1. 双击 `install.cmd`。它做三件事：自检记忆内核、拷插件到 profile、用 node 真 import 一次验证；任何一步失败都会自动回滚。
2. 装完关闭 DSH 的黑色窗口，重新双击启动器。
3. 新开会话，说一句「记住我叫阳阳」，再新开一个会话问「我叫啥」。

插件默认就是开着的。想回到原生模式，编辑 `data\profiles\web\cordis.patch.yml` 加一段覆盖，重启：

```yaml
- id: dsh-fuzzy-memory
  config:
    enabled: false
```

如果双击被系统拦住（编码/权限问题很常见），直接在 PowerShell 里粘这一行：

```powershell
& "D:\DeepSeek-Harness-Portable-0.2.0-rc.2\node.exe" "C:\Users\Administrator\Documents\deepseek-harness\default-workspace\dsh-fuzzy-memory\tools\install.mjs" "D:\DeepSeek-Harness-Portable-0.2.0-rc.2"
```

## 打包 / 发布

```bat
pack.cmd
```

产物在 `dist\dsh-fuzzy-memory-0.2.0.tgz`。发布到插件商城的完整步骤见 [PUBLISHING.md](./PUBLISHING.md)。


## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | true | 总开关，关闭时插件不生效 |
| `persona` | 空 | 基础人设文本 |
| `personaComplete` | false | true = 人设替换整个系统提示词；不要和自带 `complete` 人设的预设同时开 |
| `sampleRate` | 0.35 | 随机记忆采样率，0 = 只记显式触发 |
| `threshold` | 0.5 | 检索阈值，越高越不容易想起来 |
| `maxEntries` | 300 | 记忆库上限 |
| `cooldownTurns` | 2 | 同一条记忆至少隔几回合再出现 |
| `enableTools` | true | 是否注册 `fuzzy_remember` / `fuzzy_recall`；关掉省约 240 token/轮，自动记忆和注入照常 |

配置改动需要重启 DSH 才生效（插件只在启动时挂载）。

## 成本

| 项 | 量级 | 频率 |
|---|---|---|
| 两个工具 schema | ~240 token | 每轮（`enableTools: false` 可去掉） |
| 核心档案卡 | ~25 token | 每段会话一次，之后随历史重发 |
| 命中记忆卡 | ~30 token | 命中时一次，之后随历史重发 |
| 额外模型调用 | 0 | 抽取、检索、衰减全在本地 |

关工具的方式（profile 的 `cordis.patch.yml`）：

```yaml
- id: dsh-fuzzy-memory
  config:
    enableTools: false
```


## 记忆存在哪

```
<DSH_HOME>\fuzzy-memory\memories.jsonl
```

每行一条：

```json
{"id":"...","kw":["三体"],"gist":"黑暗森林那段还是很震撼","kind":"impression","conf":0.55,"t":1792...,"hits":1}
```

纯本地文件，可以直接看、直接改、直接删。

## 原理

1. **抽取**：中文没有分词器，用 2~4 字窗口 + 停用字过滤 + 取最长不重叠，抽到「三体」「黑暗森林」这类词；抽不到像样的就跳过。
2. **打分**：
   ```
   0.6 × 关键词重合 + 0.2 × 新鲜度 + 0.1 × 置信度 + 0.1 × 随机抖动
   ```
   抖动是故意的：同一句话，有时想得起，有时想不起。
3. **注入**：命中时在用户消息后追加一条 `user` 快照消息（不改系统提示词前缀，不破坏缓存），内容约 30 字。
4. **衰减**：只读计算，不反复改写文件；`conf × 0.8^(天数/30)`。

## 工具

- `fuzzy_remember(keywords, gist, kind?, confidence?)` — 主动记一条
- `fuzzy_recall(query)` — 主动检索，返回最像的 3 条

## 卸载

双击 `uninstall.cmd`，重启 DSH。记忆文件保留，想清空就删 `<DSH_HOME>\fuzzy-memory\`。

## 已知限制

- 中文关键词是启发式抽取，质量不如模型判断；重要的事让它调 `fuzzy_remember`。
- 注入的记忆是持久消息，会占一点上下文（约 30 token/次），只在命中时发生。
- 插件目前是 host 侧，没有独立 UI；开关和参数在「设置 → 插件」的表单里。
- 配置改动需要重启；未做热重载。
