# dsh-lan-bridge 0.2

把同一个局域网里的多台 DSH 连成**去中心化协作网**：每台电脑都是一个节点，不需要主机；可以互相浏览工作区、像 AirDrop 一样传文件、把另一台电脑的 AI 对话 fork 到本机原生会话里继续聊，也可以借用另一台电脑的模型做多机并行推理。

面板打开方式：侧边栏「局域网」图标 → 主面板。所有跨机请求都由本机宿主半代理，浏览器不会直接连接另一台电脑。

---

## 一、它能做什么

| 能力 | 说明 |
| --- | --- |
| 多工作区浏览 | 本机 DSH 工作区自动出现在列表；也可以手动添加任意目录。对已信任设备，可以浏览、读取、下载其共享工作区 |
| AirDrop 式传文件 | 选择文件 → 选择目标设备 → 对方收件箱或工作区；分块传输、逐块 SHA-256、整文件 SHA-256、断点续传、接收确认、2 GiB 上限 |
| 远程 AI 对话 | 列出另一台电脑上的会话，预览用户/助手内容，一键 fork 成本机真实 DSH session，再用 `uiWorkspace.openSession` 在原生对话界面打开 |
| 多机多模型协作 | 把同一个问题并行发给多台设备，每台用它自己的模型回答；结果回收到本机面板或本机 AI 工具里 |
| 去中心化 | 每台机器同时运行 HTTP + UDP 发现 + 同步，没有 hub/peer 角色；任意两台已信任设备直接同步 |
| 跨平台 | Windows / macOS / Linux 共用 Node 路径处理；没有平台专属运行时依赖 |
| 原生 UI | 面板注册在 DSH 原生 `sidebar.panellist` / `main` slot，颜色和圆角使用 `--dsw-*` 主题变量；远程对话最终在 DSH 原生会话中打开，而不是第二套聊天界面 |
| 自动同步 | 会话、`MEMORY.md` / `USER.md`、插件清单在已信任设备间做 anti-entropy 收敛 |

一句话：**搬的是上下文、文件和算力，不是屏幕。**

---

## 二、架构

```
        Windows 节点                                  macOS / Linux 节点
  ┌──────────────────────────┐                  ┌──────────────────────────┐
  │ DSH + dsh-lan-bridge     │                  │ DSH + dsh-lan-bridge     │
  │  · 本机会话 → 内容存储    │                  │  · 本机会话 → 内容存储    │
  │  · HTTP :47820 (HMAC)    │◀── 直接互连 ────▶│  · HTTP :47820 (HMAC)    │
  │  · UDP :47821 发现       │                  │  · UDP :47821 发现       │
  │  · 浏览器只访问本机       │                  │  · 浏览器只访问本机       │
  └──────────────────────────┘                  └──────────────────────────┘
                 ▲                                             ▲
                 └──────────── 第三台、第四台…… ───────────────┘
```

### 身份与信任

- 每个节点有稳定的 `nodeId`（沿用 v1 的 machineId）和一对 Ed25519 密钥；公钥指纹用于识别设备、发现指纹变化。
- 同一个空间共享一个 `networkKey`。邀请码里包含 spaceId、networkKey 和本机地址；拿到邀请码的机器才能通过 HMAC 校验。
- 每个请求带 `x-dsh-node / x-dsh-time / x-dsh-nonce / x-dsh-sign`，签名覆盖方法、路径、节点、指纹、时间、nonce 和 body 的 SHA-256；5 分钟时间窗 + nonce 去重防重放。
- 发现到的设备默认是 **待确认**；必须手动“信任”后才会同步、浏览文件或借用模型。“阻止”的设备不会再被连接。
- 安全边界是“信任整个空间”：networkKey 是空间级共享密钥，协议层能证明“请求来自空间成员”，不能证明“请求来自某台特定设备”。设备级信任表用于控制同步、读文件和借模型，不用于防空间内恶意成员。不要把邀请码发给不可信的人。

### 数据流

- 本地内容存储：`$DSH_HOME/lan-bridge/store/`
  - `index.json`：全局单调 `rev` + 对象索引
  - `conversations/<nodeId>/<sessionId>.json`
  - `memory/<nodeId>/<name>`
  - `manifests/<nodeId>.json`
  - `audit.jsonl`
- 同步：每个 peer 记录 `pulledThrough` / `pushedThrough` 游标；`GET /api/v2/pull?since=N` 返回下一段对象，`POST /api/v2/push` 应用对象。会话不可变，记忆/清单按 `updatedAt` last-write-wins。第三台机器的对象可以通过任意已信任 peer 传递。
- 文件传输：发送端 `POST /transfer/offer`，接收端接受后逐块 `POST /transfer/chunk`，最后 `POST /transfer/complete` 校验整文件 SHA-256 并原子落盘。下载方向由本机主动 `POST /transfer/export`，再拉取分块，避免要求对端回连。
- 远程 AI：`POST /api/v2/ai/ask` 只做普通 chat completion，使用目标机自己的 provider 凭据；**不在目标机执行工具、不读目标机文件**。远程模型默认关闭，需要在设置里显式打开。

### 端口

- HTTP：**47820**（可改）
- UDP 发现：**47821**（可改）
- 浏览器 API：本机 `/_dsh/lan/*`

---

## 三、安装

插件目录：`~/.dsh/plugins/dsh-lan-bridge/`（Windows 为 `C:\Users\<你>\.dsh\plugins\dsh-lan-bridge\`）。

把仓库同步到该目录（仓库自带 `sync-to-plugins.cmd`，Windows 双击即可），或手动复制 `index.js`、`client.js`、`lib/`、`cordis.patch.yml`、`package.json`。

在 profile（`~/.dsh/profiles/desktop/package.json`）里注册：

```jsonc
{
  "dependencies": {
    "dsh-lan-bridge": "link:C:/Users/<你>/.dsh/plugins/dsh-lan-bridge"
  },
  "dsh": {
    "profile": {
      "bundles": ["...", "dsh-lan-bridge"]
    }
  }
}
```

如果 profile 依赖有变化，在 profile 目录执行一次（registry 用 npmjs）：

```powershell
cd C:\Users\<你>\.dsh\profiles\desktop
node "E:\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\pnpm\bin\pnpm.cjs" install --registry=https://registry.npmjs.org
```

macOS / Linux 用系统 pnpm：`pnpm install --registry=https://registry.npmjs.org`。

装完**重开 DSH**，侧边栏出现「局域网」图标。

### macOS 快速安装

Windows 侧已经打好包：`dist/dsh-lan-bridge-0.2.0-macos.zip`（约 97 KB）。把它 AirDrop / U 盘 / `scp` 到 Mac，然后：

```bash
cd ~/Downloads
unzip -o dsh-lan-bridge-0.2.0-macos.zip -d lan-bridge
bash lan-bridge/install-macos.sh
```

脚本会备份旧版本、复制到 `~/.dsh/plugins/dsh-lan-bridge/`、把 `dsh-lan-bridge` 注册进 desktop profile 的 `dependencies` 和 `bundles`，并建立 `node_modules` 链接；不会碰 `~/.dsh/lan-bridge/config.json`。装完 **Command+Q 完全退出 DSH** 再打开。

前提：Mac 上已经装过 DSH 并至少启动过一次（存在 `~/.dsh`）。macOS 首次运行时在“系统设置 → 网络 → 防火墙”里允许 DSH 接受传入连接，或至少放行 TCP `47820` 和 UDP `47821`。如果 DSH 用的不是 `desktop` profile，安装时加 `DSH_PROFILE=<名字>`。

---

## 四、第一次配对

1. 两台电脑都打开「局域网 → 概览」。
2. 在 A 上点「邀请设备」，复制邀请码。
3. 在 B 上打开「设置 → 加入已有空间」，粘贴邀请码。
4. B 会通过邀请码里的地址连接 A；两边「概览」出现对方设备，状态为「待确认」。
5. 在 A 和 B 上分别点「信任」。
6. 点「同步」；概览会显示同步了多少对象。

如果 UDP 广播被防火墙挡住：在「设置 → 手动添加设备」填 `IP:47820`，或在邀请码里已经带了地址的情况下直接加入。Windows 首次运行可能弹出防火墙提示，需要允许专用网络。

---

## 五、面板

- **概览**：本机状态、设备卡片、邀请、待接收文件、同步摘要。
- **文件**：选择「本机 / 某台设备」→ 工作区 → 目录；文本可预览；远端文件可「下载到本机」，本机文件可「发送到设备」。
- **对话**：选择来源设备，列出会话；预览后「在 DSH 中打开」会把远端会话 fork 成本机真实 session，并切换到 DSH 原生对话界面。
- **AI**：选择算力来源和模型；可以问本机，也可以借用已信任设备的模型；「多机协作」把同一问题并行发给多台设备。
- **设置**：设备名、端口、发现、远程读/远程模型/自动接收/工具开关；邀请码、加入空间、手动添加设备、共享目录、信任列表、审计。

---

## 六、给 AI 用的工具

宿主启动时向 `ctx.tools` 注册（`agentTools` 开启时）：

| 工具 | 作用 |
| --- | --- |
| `lan_peers` | 列出局域网节点、信任状态、地址、最近同步 |
| `lan_workspaces` | 列出本机或远端共享工作区（只返回不透明 root id） |
| `lan_read` | 读取本机/远端工作区文本文件 |
| `lan_conversations` | 列出本机/远端会话元数据 |
| `lan_conversation` | 读取一条会话的归一化 transcript |
| `lan_ask` | 让本机或远端模型回答一个问题（远端只跑模型，不跑工具） |
| `lan_team` | 把一个 prompt 并行发给多台已信任设备 |
| `lan_send_file` | 把共享工作区的文件发到另一台设备；发送前走 DSH 原生 approval |

远端 AI 默认关闭；只有目标机设置里打开「允许信任设备借用模型」才会响应。

---

## 七、安全边界

- 浏览器只访问本机同源 `/_dsh/lan/*`；networkKey 不会进入页面。
- 所有跨机请求都必须通过 HMAC；没有邀请码的机器连 `hello` 都过不了。
- 待确认设备只能调用 `hello`，不能 pull/push、不能读文件、不能借模型。
- 文件路径只能落在共享 root 内；`..`、绝对路径、盘符、NUL、符号链接逃逸都会被拒绝；常见凭据文件名默认拒绝（`.env`、`id_rsa`、`.npmrc` 等）。
- 远端模型调用不携带工具、不读目标机文件；目标机可以用 allow list 限制模型。
- 传输先落到 `$DSH_HOME/lan-bridge/inbox/<id>/` 或目标工作区，校验 SHA-256 后才出现；接收确认默认开启。

已知限制（v0.2 有意不做）：

- 不做跨机 agent 执行。DSH 的权限/沙箱绑定在本地 session，无法安全地强加给远端调用者；远端只借用模型。
- 不做端到端加密。协议是局域网 HTTP + HMAC，能防冒充/篡改/重放，不防同网段抓包；不要把端口暴露到公网。
- 不做文件冲突合并。同名文件按“接收方确认”覆盖，旧文件可通过备份/审计找回。
- 二进制文件不在面板内预览；可以下载或发送。
- 单文件上限 2 GiB，请求体上限由传输分块控制。

---

## 八、开发与测试

```powershell
npm test
```

测试使用临时 `DSH_HOME`，不碰真实数据：

- `test/v2-core.mjs`：v1→v2 配置/存储迁移、HMAC 重放、传输分块校验
- `test/v2-ai.mjs`：模型发现、流式回答、多机 fan-out、8 个工具
- `test/render-v2.mjs`：客户端 bundle 加载与 slot 注册
- `test/v2-host.mjs`：宿主 boot、浏览器 API、CORS 边界
- `test/fork.mjs`：22 项 fork 格式校验
- `test/v2-e2e.mjs`：两个真实 Node 节点进程 — 邀请、信任、同步、远端读文件、下载、发送、借模型、多机 fan-out、远程 fork

除了上面的自动化测试，0.2 还在真实 DSH `0.2.1-rc.5` 里做过一次手工集成验证：临时 profile 加载插件后，宿主 boot、侧边栏「局域网」入口、五个标签页、文件树、两个真实 DSH 进程的邀请/加入/信任/同步/远端读/发送都正常；`uiWorkspace` 注入后“在 DSH 中打开”能切到原生会话；`tools` 注入后 8 个 `lan_*` 工具出现在宿主工具表里。

单独跑：`node test/v2-e2e.mjs`。

---

## 九、目录

```
index.js             宿主半：路由、生命周期、节点编排
client.js            浏览器半：原生 slot 面板
lib/config.js         v2 配置 + v1 迁移
lib/identity.js       Ed25519 身份、邀请码
lib/auth.js           HMAC 请求签名/校验
lib/peers.js          设备表、信任、同步游标
lib/store.js          内容寻址存储 + v1 迁移
lib/mesh.js           多 peer anti-entropy
lib/discovery.js      UDP 发现
lib/transport.js      HTTP 服务端/客户端
lib/transfer.js       AirDrop 分块传输
lib/workspaces.js     工作区目录
lib/ai.js             远端模型调用与 fan-out
lib/agent-tools.js    8 个模型工具
lib/files.js          路径安全、读写、导入
lib/sessions.js       会话日志解析
lib/fork.js           远端 transcript → 本地 DSH session
lib/memory.js         MEMORY.md / USER.md
lib/plugins.js        插件清单与应用
```
