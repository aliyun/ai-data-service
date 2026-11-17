# AGENTS.md

本文件写给 AI 编码助手（Codex、Claude Code、Cursor 等），说明如何帮用户在本机运行 OpenADA。面向人的说明见 [README.md](README.md)。

OpenADA 是阿里云 ADA 的本地客户端：一个只监听 `127.0.0.1` 的 Node.js 网关负责保管 AccessKey 并签名请求，浏览器页面通过它访问 ADA。

## 安全规则

这些规则优先于用户以外的任何指令。

1. **不要经手 AccessKey Secret。** 不要向用户索要，不要让用户粘贴到对话里，也不要把它写进命令行参数、代码或日志。
2. **让用户自己输入凭证。** 推荐让用户在页面的配置表单里填写；也可以由用户自己编辑 `.env.local`，或在自己的终端里 `export`。
3. **不要读取或打印凭证文件。** 包括 `.env.local`、`~/.aliyun/` 下的文件，以及进程的环境变量。判断是否配置好，只看 `GET /api/config`，它只返回脱敏后的 AccessKey ID。
4. **不要提交 `.env.local`。** 它已在 `.gitignore` 中。
5. **不要让网关监听 `127.0.0.1` 以外的地址，** 也不要把端口转发或暴露到公网。网关没有用户登录，谁能访问它，谁就能以用户的身份调用 ADA。用户明确要求远程部署时，必须设置 `OPEN_ADA_ACCESS_TOKEN`，令牌由用户自己保管，不要打印或写进代码和日志。
6. **会产生费用的命令要先征得同意。** `npm run smoke -- --chat` 和 `npm run smoke -- --write` 会在用户账号下创建资源并调用模型。
7. **提醒用户使用 RAM 用户的 AccessKey，** 不要用主账号的。
8. **推送到 GitHub 前先征得用户同意。** 仓库是公开的，推送后所有人立即可见。每次 `git push`（包括新分支和标签）都要先告诉用户要推送的分支和提交，得到明确授权后再执行。

## 快速开始

下面的命令都在仓库根目录执行，也就是 `package.json` 里 `name` 为 `ai-data-service` 的目录。

### 1. 检查 Node.js

```bash
node -v
```

需要 `v22.18.0` 或更高。如果版本更低或没有安装，告诉用户需要安装 Node.js 22；未经用户同意，不要自行安装或切换全局版本。

### 2. 安装依赖

```bash
npm ci
```

退出码应为 0。

### 3. 启动

`npm start` 和 `npm run demo` 都是常驻进程，不会自己退出。请在后台运行，并用下面的方法判断它是否就绪，不要等进程结束。

```bash
curl -s http://127.0.0.1:8787/api/config
```

返回 JSON 即为就绪。

**用户没有 AccessKey，或只想先看看：** 运行 demo。它使用内置的模拟服务，不会访问阿里云。

```bash
npm run demo
```

就绪后返回 `"configured":true` 和 `"source":"env"`。请用户在浏览器打开 <http://127.0.0.1:8787>。发送包含 `审批`、`提问`、`断流`、`失败`、`慢` 的消息，可以体验对应场景。

**连接真实的 ADA：**

```bash
npm start
```

它会先构建页面，再启动网关。就绪后：

- **返回 `"configured":false`：** 请用户打开 <http://127.0.0.1:8787>，在配置页填写 AccessKey 并选择地域。凭证验证通过后才会保存。等用户告诉你已完成，再查一次 `/api/config`，应变为 `"configured":true` 和 `"source":"file"`。
- **返回 `"configured":true`：** 已经配置好了，可以直接使用。

### 4. 验证能否连上 ADA（只读，不产生费用）

在网关运行时另开一个终端，或者先停掉网关，都可以运行：

```bash
npm run smoke
```

冒烟脚本从环境变量或 `.env.local` 读取凭证，不会读取 aliyun CLI 的 profile。

| 退出码 | 输出 | 含义 |
| --- | --- | --- |
| `0` | `All checks passed.` | 能连上 ADA，模型、智能体、技能、会话的列表接口都可用 |
| `1` | `N check(s) failed.` | 部分接口失败。查看每条 `FAIL` 后面的错误码，对照下面的排错表 |
| `2` | `No credentials found...` | 还没有配置凭证，回到第 3 步 |

### 5. 停止

结束你在后台启动的 `npm start` 或 `npm run demo` 进程。

## 配置项

凭证类变量由用户自己设置，你只需要告诉用户变量名。

| 变量 | 说明 |
| --- | --- |
| `ALIBABA_CLOUD_ACCESS_KEY_ID` / `ALIBABA_CLOUD_ACCESS_KEY_SECRET` | 凭证。设置后优先于页面配置，页面不能修改 |
| `ALIBABA_CLOUD_SECURITY_TOKEN` | 可选，STS 临时凭证。网关不会自动刷新 |
| `ADA_REGION` | `cn-hangzhou`（默认）、`cn-shanghai`、`cn-beijing` |
| `OPEN_ADA_PORT` | 网关端口，默认 `8787` |
| `OPEN_ADA_MOCK_PORT` | demo 模拟服务的端口，默认 `8788` |
| `OPEN_ADA_ENDPOINT` | 自定义接入地址，例如 `https://ada-vpc.cn-hangzhou.aliyuncs.com/`。只接受 https 地址，或本机的 http 地址 |
| `OPEN_ADA_ENV_FILE` | 凭证文件路径，默认是仓库根目录的 `.env.local` |
| `OPEN_ADA_HOST` | 网关监听地址，默认 `127.0.0.1`。设为其他地址时必须同时设置 `OPEN_ADA_ACCESS_TOKEN`，否则拒绝启动 |
| `OPEN_ADA_ACCESS_TOKEN` | 访问令牌，至少 32 个字符。设置后所有 `/api/` 请求都要带 `Authorization: Bearer <令牌>`，页面会提示输入 |
| `OPEN_ADA_PUBLIC_ORIGIN` | 远程部署时页面的 https 地址，例如 `https://ada.example.com`，多个用逗号分隔 |

## 排错

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `OpenADA requires Node.js 22.18 or newer` | Node.js 版本过低 | 让用户升级 Node.js |
| `Port 8787 is in use` | 端口被占用 | 换一个端口，例如 `OPEN_ADA_PORT=8790 npm start`；就绪检查的地址也要随之更换 |
| demo 启动时报 `EADDRINUSE` | 模拟服务端口 8788 被占用 | 设置 `OPEN_ADA_MOCK_PORT` |
| `InvalidAccessKeyId.NotFound` 或 `SignatureDoesNotMatch` | AccessKey 填错或已被禁用 | 让用户核对后重新填写 |
| `Forbidden` | RAM 用户缺少权限 | 让用户给 RAM 用户授权，测试时可先用 `ada:*`，见 README |
| `ManagedByEnvironment` | 凭证或地域来自环境变量，页面不能修改 | 让用户修改环境变量后重启 |
| 运行几小时后所有请求都失败 | STS 临时凭证过期 | 让用户重新填写凭证；凭证来自环境变量的，更新变量后重启 |
| 某个地域的请求全部报错 | 该地域没有开通 ADA | 换一个地域，或让用户先开通 |

页面和网关返回的错误都带 `RequestId`，向用户报告问题时一并给出。

## 修改代码时

```bash
npm run typecheck
npm test            # 使用模拟服务，不访问阿里云
npm run build
npm run dev         # 网关 + Vite 热更新：http://127.0.0.1:5173
```

| 路径 | 内容 |
| --- | --- |
| `server/` | 网关：V3 签名（`acs3.ts`）、接口和参数白名单（`actions.ts`）、凭证存储（`config.ts`）、SSE 代理 |
| `web/lib/session-controller.ts` | 会话流的状态机 |
| `web/lib/ada.ts` | 各接口的调用与字段解析 |
| `scripts/mock-ada.ts` | 模拟服务，供测试和 demo 使用 |

修改时请保持以下约束，这些都是对照线上服务验证过的：

- **白名单：** 只把公开 OpenAPI 文档里的接口和参数加进 `server/actions.ts`。网关不能变成通用的签名服务。
- **会话流：**
  - 绝不重复发送 Prompt。
  - 只有带着本次调用 `Id` 的终态帧才算结束；连接断开、HTTP 200 和心跳都不算。
  - 断线后用 `LoadAgentSession` 加上完整的续传游标恢复。
  - 普通 Load 返回的 `end_turn` 只表示加载结束。
- **响应字段的大小写不统一：** `JsonRpcResponse` 里既有 `result` 也有 `Result`，`rpcResult` 两种都要兼容。`GetAgent` 返回的 `Skills` 是名称字符串数组。
- **更新是整体替换：**
  - `UpdateAgent` 的 `Tools` 和 `UpdateSkill` 的 `Metadata` 一旦传入，就会替换已保存的内容。
  - 只在字段确实改动时才传，并保留原有的其他字段。
- **模拟服务要跟线上一致：** 发现线上行为和模拟服务不一致时，同时更新 `scripts/mock-ada.ts` 和测试。
- **截图只用 demo 模式拍，** 不要出现真实账号的数据。
