# 更新记录

## 0.2.1 — 2026-11-02

macOS 兼容性补丁：0.2.0 在某些 Mac 版 DSH 上会因为客户端声明的可选服务不存在而在启动时抛 JavaScript 错误。

### 修：旧版 DSH 启动崩溃

- 客户端 `inject` 回到只声明 `slots`；`uiWorkspace` / `sessions` 改为运行时 `ctx.get(...)` 可选访问。缺少这些服务时，“在 DSH 中打开”降级为“已写入本机，请从侧栏打开”，面板和宿主照常启动。
- 宿主 `inject` 回到只声明 `webServer`；`ctx.get('tools')` 作为可选访问。旧版 DSH 没有 tools 服务时只是不注册 AI 工具，不会拖垮插件启动。
- `package.json` 的 `dsh.client.inject` 同步改回 `["slots"]`。
- 安装脚本、zip、README 版本号更新到 0.2.1。

## 0.2.0 — 2026-11-02

一次架构级重写：从「两台机器的 hub/peer」变成「每台机器都是节点的局域网 mesh」，并把面板改成设备中心。

### 新：去中心化网络

- 移除 `role: hub | peer`。每个节点同时运行 HTTP 服务、UDP 发现和同步循环，任意已信任设备直接互连。
- 节点身份改为 `nodeId` + Ed25519 密钥对；设备表新增 `trusted / pending / blocked` 三档信任，发现到不等于信任。
- 请求用共享 `networkKey` 做 HMAC-SHA256 签名，覆盖方法、路径、节点、时间、nonce 和 body 哈希；5 分钟时间窗 + nonce 去重防重放。
- v1 配置自动迁移：旧 `machineId` 变成 `nodeId`，旧 `token` 拉伸成 v2 `networkKey`，所以两台旧机器升级后仍在同一个空间里。
- 邀请码包含 spaceId、networkKey 和地址，取代旧的手填 token。

### 新：多 peer 同步

- 存储改为内容寻址 + 全局单调 `rev`；会话不可变，记忆和插件清单按 `updatedAt` last-write-wins。
- 每个 peer 维护 `pulledThrough` / `pushedThrough` 游标；`GET /api/v2/pull?since=N` + `POST /api/v2/push`，第三台机器的对象可以经任意 peer 传递。
- v1 的 `store/index.json`、`conversations/`、`memory/`、`manifests/` 自动导入 v2，旧索引保留为 `index.v1.json`。

### 新：AirDrop 式文件传输

- 发送端 offer → 接收端确认（或自动接收）→ 分块传输 → 整文件 SHA-256 校验 → 收件箱或目标工作区原子落盘。
- 每块单独 SHA-256；断点续传；接收方可选收件箱或工作区；单文件上限 2 GiB。
- 下载方向由本机主动 export + 拉块，不需要对端回连。

### 新：远端对话与原生打开

- 远端会话列表、transcript 预览、一键 fork 到本机真实 DSH session。
- fork 后客户端调用 `ctx.uiWorkspace.openSession(sessionId)`，直接切回 DSH 原生对话界面；面板不再充当第二套聊天客户端。

### 新：远端模型与多机协作

- `POST /api/v2/ai/ask` 只执行普通 chat completion，使用目标机自己的 provider 凭据，不携带工具、不读目标机文件。
- 远端模型默认关闭，必须显式打开；支持模型 allow list 和每日额度。
- 新增 8 个模型工具：`lan_peers / lan_workspaces / lan_read / lan_conversations / lan_conversation / lan_ask / lan_team / lan_send_file`；发送文件走 DSH 原生 approval。
- 多机 fan-out：同一 prompt 并行发给多台已信任设备，结果回到面板或本地 AI。

### 新：原生 UI

- 面板重写为设备中心：概览 / 文件 / 对话 / AI / 设置。
- 颜色、圆角、边框改用 DSH 原生 `--dsw-*` token，自动跟随明暗主题。
- 移除自绘 Markdown 聊天主界面；只保留轻量预览，真正的对话交给 DSH。

### 真实 DSH 集成修正

- 客户端显式注入 `uiWorkspace` / `sessions`，否则 `ctx.uiWorkspace` 在 Cordis 里会报 “cannot get property ... without inject”，“在 DSH 中打开”只会写文件、不能切到原生会话。
- 宿主显式注入 `tools`，否则 8 个 `lan_*` 工具注册会静默失败；状态接口现在会列出已注册工具名。
- 浏览器 API 不再返回 `Access-Control-Allow-Origin: *`，避免任意网页读取邀请码/驱动局域网 API；LAN 传输仍用 HMAC 保护。
- 邀请码优先选择真实 RFC1918 网卡，跳过 Tailscale / VMware / Hyper-V / Docker 等虚拟网卡。
- fork 后如果客户端会话目录尚未刷新，先 `sessions.manager.refreshList()` 再重试 `openSession`。

### 安全

- 待确认设备只能调用 `hello`；同步、读文件、借模型都要求 `trusted`。
- 文件路径限制在共享 root 内，拒绝 `..`、绝对路径、盘符、NUL、符号链接逃逸和常见凭据文件名。
- 远端模型不执行工具；不提供跨机 agent 执行。

### 测试

- 新增 `test/v2-core.mjs`、`test/v2-ai.mjs`、`test/render-v2.mjs`、`test/v2-host.mjs`、`test/v2-e2e.mjs`。
- `v2-e2e` 起两个真实节点进程，覆盖邀请、加入、信任、同步、远端读文件、下载、发送。

## 0.1.4 — 2026-10-26

0.1.3 的补丁：fork 失败时的报错终于说人话了。

### 修：空会话 / 失效工作区不再回 500

- 对一条**空会话**（对端只同步过来一个 header，没有任何消息）点 Fork，以前回 `500 handler-error`，面板上只剩「HTTP 500」这种没头没脑的提示。现在回 `400` + `EMPTY_CONVERSATION`，并原样显示「这条会话没有可 fork 的内容」。
- 下拉里选中的工作区如果在扫描之后被删掉，以前会**悄悄 fork 到别的（最近活跃的）工作区** —— 这是真 bug。现在明确拒绝：`400` + `NO_WORKSPACE` +「目标工作区不存在了（可能已被删除），刷新后重新选一个」。
- 「对话」页签打开一条空会话时，Fork 按钮直接置灰并提示「这条会话是空的」，不再让人白点一次。

### 其他

- `test/fork.mjs` 22 项：新增「指定不存在的工作区不会悄悄落到别的工作区」；两处错误断言改成校验 `code`。
- `test/e2e.mjs` 的 fork 步骤补了 `NO_WORKSPACE` 反向用例。

## 0.1.3 — 2026-10-26

紧跟着 0.1.2 的一次修复 + 一个新功能：那个版本会让局域网面板整个渲染失败。

### 修：局域网面板报「渲染失败」/ `think is not defined`

- 症状：升级到 0.1.2 后打开侧边栏面板，只看到错误边界渲染出的「局域网面板渲染失败」和一串堆栈，首行是 `ReferenceError: think is not defined`，栈顶在 `TranscriptItem`，其下是 `Array.map`。
- 原因：0.1.2 的「思考链一键折叠」在 `TranscriptItem` 里用了一个裸标识符 `think`，但这个函数自己不声明它 —— 状态定义在 `ConversationView`（`const [think, setThink] = useState({ open: false, gen: 0 })`），渲染 `TranscriptItem` 时忘了往下传。只有含助手正文的会话才会走到那条分支，所以不是每次打开面板都炸。
- 修：`TranscriptItem` 改为 `const think = props.think`（原位置是早已没用的 `const children = props.children`），`ConversationView` 的 `items.map(...)` 补上 `think: think`。

### 修：Markdown 排版错乱（行距贴在一起、字重失效、嵌套列表被拍平）

- 症状：0.1.2 里同步过来的正文虽然认得出标题和列表，但整体「挤成一团」——行与行几乎叠着，标题跟正文一样粗。
- 原因：`css()` 给所有数字值一律补 `px`。于是 `lineHeight: 1.62` 生成 `line-height: 1.62px`（行高只有 1.62 像素），`fontWeight: 640` 生成 `font-weight: 640px`（非法值，浏览器直接丢弃）。
- 修：新增无单位属性白名单（`lineHeight`、`fontWeight`、`opacity`、`zIndex`、`flex`、`lineClamp` 等），只有真正的长度值才补 `px`。
- 顺带修掉几处结构问题：更深的缩进现在是父 `<li>` 里的子列表（不再是并排的兄弟项）；表格横向滚动、识别 `:---:` / `---:` 对齐、紧跟段落的表格不再被段落吞掉；首个标题不再带 14px 上边距。

### 新：把任意一条对话 Fork 到本机工作区

- 面板右侧新增工具条：挑一个本机工作区 → 点「Fork」，把当前展开的这条对话（本机的，或别的电脑同步过来的）写成一份**能直接接着聊的 DSH 会话**。
- 实现照 DSH 自己 `buildForkSeed` 的语义手写 v4 会话文件：`~/.dsh/sessions/<workspace-key>/session-<uuid>/session.v4.jsonl.zstd`，两段带 checksum 的 zstd 帧（header 帧 + 事件帧），事件按 `turn/start → step/start → user/message → session/title → assistant/message → step/end → turn/end` 排列，`seq` 从 0 稠密递增。
- 写完顺带调 `workspaceRegistry.resolveByPath(cwd).attachSession(id)` 把它挂进目标工作区，所以正常情况下**不用重启 DSH**，刷新页面就能在侧栏看到；注册表不可用时退回「已写入，重启后可见」，文件本身已经写好。
- 只搬对话内容（用户消息 + 助手正文），工具调用与思考链不搬：远程同步过来的本来就只有归一化后的条目，硬造 `tool/call` 会变成孤儿事件被结构校验拒掉。
- 生成的文件在真机上用 DSH 自己的格式代码（`sessionFormatCatalog` 的 `readHeader` / `createRestore(...).decodeRow` / `finish`）校验通过：`status=current`、`storedVersion=4`、v4 关系校验无报错。

### 其他

- 测试扩到六套：smoke 12/12、e2e 10/10（新增 fork 步骤，覆盖 attach 成功与注册表不可用两种情况）、two-machines 8/8、markdown 34/34、render 14/14、fork 21/21。
- `test/render.mjs`（14 项）不只盯 0.1.2 那个崩溃：现在喂固定 state 渲染「对话」页签，断言 fork 工具条的下拉框与按钮、以及已打开会话的正文都渲染出来。
- `test/markdown.mjs` 从 23 项扩到 34 项，专盯 `line-height` / `font-weight` 的单位、嵌套列表结构、表格对齐与横向滚动。

## 0.1.2 — 2026-10-26

### 新：同步过来的正文按 Markdown 渲染

之前助手正文是一整块纯文本，`##`、`` ` ``、`**` 这些记号原样显示。现在 `client.js` 里带了一个自写的解析器（不引入任何依赖，保持插件可单文件分发）：

- 支持：标题 `#`～`######`、围栏代码块 ``` ``` ``、行内 `code`、`**粗体**`、`*斜体*`、`~~删除线~~`、`[文字](链接)`、裸 URL、无序 / 有序列表、引用 `>`、分隔线、管道表格。
- 先转义再套格式：`<script>` 之类只会当文字显示；`javascript:` 链接直接丢弃，只放行 `http(s):` 与 `mailto:`。
- 围栏代码块与行内代码内部不再做格式化，`**not bold**` 保持原样。

### 新：思考链一键折叠

- 正文区顶部新增「展开全部思考 / 折叠全部思考」，一次控制本轮对话的全部思考链；单条的「思考链」块仍可单独点开。
- 没有思考内容时按钮置灰，并提示「本次对话没有思考内容」。

### 其他

- 新增 `test/markdown.mjs`（23 项断言），覆盖标题、围栏、行内、列表、表格、HTML 转义与链接白名单。
- 四套测试：smoke 12/12、e2e 9/9、two-machines 8/8、markdown 23/23。
- 修 `css()` 数字值缺 `px` 的问题（生成的 `font-size:17` 在浏览器里无效）。

## 0.1.1 — 2026-10-26

都是两台机器**真连上之后**才暴露出来的问题。

### 修：局域网发现搜不到对端

- **任何角色都广播**：`index.js` 的 `reconcileBeacon()` 之前写死 `role !== 'hub'` 就直接 return，成员机器从不广播，于是主机侧永远搜不到成员。现在只要开着「自动发现」就广播、并应答别人的探测。
- **逐网卡定向广播**：新增 `broadcastTargets()`，按每块网卡的掩码算出 `192.168.x.255`，不再一律丢给 `255.255.255.255`——多网卡的 Windows 会从默认路由那块网卡发出去（VMware / Tailscale 常抢到默认路由），包根本到不了局域网。
- **单播回包**：收到探测时先单播回给对方，再走定时广播；macOS 拦掉广播后仍然连得上。
- 发现结果标注「主机 / 成员」，非主机条目不可点选（不能把成员当主机填）。

### 修：同步被 32 MiB 挡住

- 报错 `request body exceeds 33554432 bytes`：33554432 字节 = 32 MiB，是主机拒收的请求体上限（`lib/lan-server.js` 的 `MAX_POST`）。
- 新增 `splitPayload()`：推送按 8 MiB 分批串行发送，单请求不再有可能触顶。
- 推送改增量：只发水位之后变动的记录，水位存 `$DSH_HOME/lan-bridge/cache/sync.json`；任一批失败则水位不前进，下次重发。
- 拉取水位同样持久化，并绑定主机指纹（地址 + 端口 + 令牌哈希），换主机自动从 0 重放，不会静默漏数据。

### 其他

- `test/smoke.mjs` 增加分批断言（12/12 通过）；e2e 9/9、two-machines 8/8。
- README 补「单次请求 8 MiB 上限」与增量水位说明。

## 0.1.0 — 首次交付

共享对话（含思维链、工具调用与结果）、共享记忆、插件清单比对与一键应用、远程文件查看与修改、审计日志。
