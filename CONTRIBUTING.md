# 参与贡献

感谢你愿意改进 OpenADA。参与本项目即表示你同意遵守[行为准则](CODE_OF_CONDUCT.md)。

## 报告问题

- 提交 [Issue](https://github.com/aliyun/ai-data-service/issues) 前，请先搜索是否已有相同的问题。
- 请写明 Node.js 版本、操作系统、地域、复现步骤，以及页面或网关返回的错误码和 `RequestId`。
- **不要在 Issue、截图或日志里贴出 AccessKey、STS Token 或真实账号的数据。**
- 安全漏洞请不要公开提交，按 [SECURITY.md](SECURITY.md) 私下报告。

## 开发环境

需要 Node.js 22.18 或更高版本。

```bash
npm ci
npm run demo        # 使用内置模拟服务，不需要 AccessKey
npm run dev         # 网关 + Vite 热更新：http://127.0.0.1:5173
```

## 提交 Pull Request

1. Fork 仓库，从 `main` 新建分支。
2. 提交前确认以下命令都通过：

   ```bash
   npm run typecheck
   npm test            # 使用模拟服务，不访问阿里云
   npm run build
   ```

3. 修复问题时补充能复现它的测试。
4. 改动界面时，附上 `npm run demo` 下的截图。截图里不能出现真实账号的数据。
5. 提交信息使用 `类型: 说明` 的格式，例如 `fix: 断线后恢复会话时丢失消息`。常用类型有 `feat`、`fix`、`docs`、`refactor`、`test`。

## 代码约束

这些约束都是对照线上服务验证过的，修改时请保持：

- **接口白名单：** 只把公开 [OpenAPI 文档](https://help.aliyun.com/zh/ada/developer-reference/api-ada-2026-07-01-overview)里的接口和参数加进 [`server/actions.ts`](server/actions.ts)。网关不能变成通用的签名服务。
- **网关只监听 `127.0.0.1`，** 密钥不能返回给浏览器，也不能写进日志。
- **会话流：** 绝不重复发送 Prompt；只有带着本次调用 `Id` 的终态帧才算结束；断线后用 `LoadAgentSession` 加上完整的续传游标恢复。
- **更新是整体替换：** `UpdateAgent` 的 `Tools` 和 `UpdateSkill` 的 `Metadata` 只在确实改动时才传。
- **模拟服务要跟线上一致：** 发现线上行为和 [`scripts/mock-ada.ts`](scripts/mock-ada.ts) 不一致时，同时更新模拟服务和测试。

更多细节见 [AGENTS.md](AGENTS.md) 的「修改代码时」一节。

## 许可证

你提交的贡献将按 [Apache License 2.0](LICENSE) 授权。
