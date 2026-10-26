# dsh-lan-bridge

把同一局域网里的两台 DSH（Windows + macOS）连成一个小平台：**共享对话、共享记忆、一键同步插件清单、远程查看和修改工作区文件**。

面板打开方式：侧边栏「局域网」图标 → 主面板，五个标签页：对话 / 插件 / 文件 / 记忆 / 设置。

---

## 一、它能做什么

| 能力 | 说明 |
| --- | --- |
| 共享对话 | 任意一台电脑上的提问与回答都会进入共享区，另一台的「对话」页可以完整看到**思维链、每一次工具调用与返回、最终输出**，顺序与原会话一致 |
| 共享记忆 | 把本机找到的 `MEMORY.md` / `USER.md` 同步到共享区；对端的版本可以一键覆盖本机（覆盖前自动备份） |
| 插件清单 | 读取本机 profile 的插件依赖与 bundle 列表；对端清单到达后可「一键应用」，再一键跑 `pnpm install` |
| 文件 | 浏览、编辑、删除、重命名工作区文件——本机或对端都行；写入走「临时文件 + 替换」，旧内容备份到 `$DSH_HOME/lan-bridge/backups/`（不污染被共享的目录） |
| 同步计划 | 实时（默认）/ 手动两档；推送与拉取间隔可调 |

一句话：**在两台电脑之间搬「上下文」，而不是搬「屏幕」。**

---

## 二、架构

```
        Windows (hub 主机)                        macOS (peer 成员)
  ┌──────────────────────────┐            ┌──────────────────────────┐
  │ DSH + dsh-lan-bridge     │            │ DSH + dsh-lan-bridge     │
  │  · 扫描本机会话 → 共享区  │            │  · 扫描本机会话 → 共享区  │
  │  · HTTP :47820 (带令牌)  │◀──令牌────▶│  · 定时 push / pull      │
  │  · UDP :47821 广播发现   │            │  · 浏览器只与本机 :54115 │
  └──────────────────────────┘            └──────────────────────────┘
```

- 浏览器（面板）**只**访问本机的 `/_dsh/lan/*`；跨机请求全部由宿主半（`index.js`）发起，令牌不会进入页面以外的任何地方。
- 共享区是磁盘上的普通文件，位置：`$DSH_HOME/lan-bridge/`
  - `store/conversations/<machineId>/<sessionId>.json`
  - `store/memory/<machineId>/<name>`
  - `store/manifests/<machineId>.json`
  - `store/audit.jsonl`（谁在什么时候读过什么、写过什么）
  - `cache/export.json`（导出游标，避免重复扫描）、`cache/roots.json`
  - `backups/<rootId>/<原路径>.<时间戳>.bak`（远程写文件前的旧内容）
- 端口：HTTP **47820**、UDP 发现 **47821**（可在设置里改；UDP 被路由器挡住也能手动填地址配对）。

---

## 三、两台电脑都要装

插件目录：`~/.dsh/plugins/dsh-lan-bridge/`（Windows 为 `C:\Users\<你>\.dsh\plugins\dsh-lan-bridge\`）。

注册进 profile（`~/.dsh/profiles/desktop/package.json`）：

```jsonc
{
  "dependencies": {
    "dsh-lan-bridge": "link:C:/Users/<你>/.dsh/plugins/dsh-lan-bridge"
  },
  "dsh": {
    "profile": {
      "bundles": [ "...", "dsh-lan-bridge" ]
    }
  }
}
```

然后在 profile 目录执行一次安装（Windows 内置 pnpm 的路径见下），**registry 必须用 npmjs**：

```powershell
cd C:\Users\<你>\.dsh\profiles\desktop
node "E:\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\pnpm\bin\pnpm.cjs" install --registry=https://registry.npmjs.org
```

macOS 上换成系统 pnpm 即可：`pnpm install --registry=https://registry.npmjs.org`。

装完**重开 DSH**，侧边栏出现「局域网」图标。

---

## 四、第一次配对（三分钟）

在**常开的那台**（设为 hub）：

1. 打开 局域网 → 设置 → 角色选「主机」，端口保持 47820，保存。
2. 面板会显示局域网地址（例如 `192.168.1.23`）和一串共享令牌，复制这两样。
3. 确认系统防火墙放行了该端口（Windows 首次监听会弹窗，选「允许专用网络」）。

在**另一台**（设为 peer）：

4. 设置 → 角色选「成员」，填主机地址 + 端口 + 令牌。
5. 点「局域网自动发现」可自动填地址；点「测试连接」应提示「连接成功 · rev N」。
6. 保存，回到「对话」页，点右上角「立即同步」。

两台都看到对方的会话，就通了。

> 令牌是两台互信的唯一凭据，等于密码。换掉它只需在主机改、在成员同步改一次即可。

---

## 五、五个页面怎么用

- **对话**：左侧按电脑筛选、按标题/路径搜索；点开右侧看完整过程。思考链与工具输出默认折叠，点一下展开。会话按机器分目录存放，互不覆盖。
- **插件**：上半是本机清单（绿色点=运行中），中间是对端清单与差异（待安装 / 版本不同 / 待启用 bundle），点「一键应用」只改 profile 的 `package.json`，不会自动联网；改完点「运行 pnpm install」。
- **文件**：先选「本机 / 对端」，再选共享根目录（默认按本机真实用过的工作区自动列出），左侧目录、右侧编辑，保存留备份。
- **记忆**：列出本机探测到的记忆文件与共享区里的版本；「用这份覆盖本机」会在覆盖前备份原文件。
- **设置**：角色与端口、令牌、发现、同步计划、共享根目录增删、最近活动（审计）。

---

## 六、安全边界（请读一遍）

- 所有跨机接口都要求令牌；没有匿名路由。
- 文件访问**只能**落在明确共享的根目录内：路径做规范化后校验，拒绝 `..`、绝对路径和符号链接逃逸。
- 默认拒绝读写 `.env`、`.git/config`、`*.pem`/`*.key`/`id_rsa`、`credentials*`、`secrets*`、`.ssh/**` 等敏感形状。
- 删除与重命名不做二次确认以外的保护，**不可恢复**；重要目录先别加进共享列表。
- 令牌存于 `$DSH_HOME/lan-bridge/config.json`，只在本机使用。

---

## 七、故障排查

| 现象 | 处理 |
| --- | --- |
| 测试连接失败 `UNREACHABLE` | 端口没监听、防火墙拦截、或两台不在同一网段；先在主机 `curl http://127.0.0.1:47820/api/hello` 自测 |
| `BAD_TOKEN` | 两台令牌不一致，重新复制一次 |
| 自动发现不到 | 路由器禁止广播；直接手填地址，不影响使用 |
| 面板显示「渲染失败」 | 插件客户端包版本变了而页面还是旧的，`Ctrl+F5` 硬刷新整个窗口 |
| 对话里没有新内容 | 点「立即同步」；或把拉取间隔调小；确认对方会话确实产生过事件 |
| 插件页「应用清单」后没生效 | 必须再点「运行 pnpm install」，然后重开 DSH |

---

## 八、明确的限制

- **不合并记忆**：两份 `MEMORY.md` 有冲突时，由你选「用谁覆盖谁」，插件不做自动 merge（合并语义无法猜）。
- **不做文件冲突解决**：同时改同一个文件，后写的赢；写入前会留备份。
- **不是逐字实时**：会话按事件批量导出（默认推送 2s / 拉取 4s 的节奏），是「秒级」，不是「打字级」。
- **单次请求 8 MiB 上限**：推送按 8 MiB 分批发，主机的 32 MiB 请求体上限因此不再是天花板；单条对话本身受 `maxConversationBytes`（默认 8 MiB）限制。增量靠 `sync.json` 记录推送/拉取水位，换主机（地址、端口或令牌变了）会自动从零重放。
- **不替代 DSH 自动化**：需要定时跑代理任务的场景，请用 DSH 自带的自动化功能；本插件的「同步计划」只负责同步。
- 只在**两台**机器上验证过（Windows hub + macOS peer）。三台以上没有专门设计，令牌与共享区是同一个，行为等同「多成员接一个主机」，未做冲突检测。

---

## 九、开发

```powershell
cd .dsh\plugins\dsh-lan-bridge
node test/smoke.mjs          # 12 项离线检查：zstd 帧解析、事件归一化、store、文件防护、清单差异、导出增量、分批切分
node test/e2e.mjs            # 9 步：不依赖 DSH 启动宿主半，走完本地路由 + LAN 接口（含错误令牌）
node test/two-machines.mjs   # 8 步：两个进程、两个 DSH_HOME，验证对话/记忆/清单/文件真正跨机
node test/markdown.mjs       # 23 项：正文 Markdown 渲染（标题、围栏、行内、列表、表格、转义、链接白名单）
```

四套测试全部使用临时目录，不碰真实 `$DSH_HOME`，也不占用 47820 端口（用随机高位端口）。
`test/markdown.mjs` 不依赖浏览器：它从 `client.js` 里截出 markdown 段落，用桩 `C`/`h`/`useMemo` 在本机跑。

### 打 macOS 更新包

```powershell
powershell -File scripts\build-macos-zip.ps1
```

产物是 `dist/dsh-lan-bridge-<version>-macos.zip`，内含 `install-macos.sh`、`更新说明.txt` 和完整插件目录。
版本号取自 `package.json`，改了版本再跑一次即可。

宿主半（`index.js` + `lib/`）是普通 ESM，可单独 `node --check`。浏览器半（`client.js`）是一个 `window.__ModuleLoader__.load` 工厂，用 `React.createElement`（无 JSX），通过 `ctx.slots` 注册侧边栏与主面板。
