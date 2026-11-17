# 安全策略

OpenADA 的本地网关保管 AccessKey 并代替浏览器签名请求，我们非常重视它的安全问题。

## 报告漏洞

**请不要通过公开的 Issue、Pull Request 或讨论区报告安全漏洞。**

请通过 GitHub 的私密漏洞报告提交：<https://github.com/aliyun/ai-data-service/security/advisories/new>

报告中请尽量包含：

- 受影响的版本或提交
- 漏洞类型和影响，例如密钥泄露、绕过接口白名单、跨站访问网关
- 复现步骤或概念验证代码

不要在报告中附上真实的 AccessKey 或账号数据。我们会尽快确认收到，并在修复发布后公开说明。

## 支持的版本

只有 `main` 分支的最新版本会收到安全修复。

## 使用建议

- 使用只有所需权限的 RAM 用户 AccessKey，不要使用主账号的 AccessKey。
- 不要把网关监听地址或端口转发、暴露到 `127.0.0.1` 以外。
- 不要在共享机器上使用长期有效的 AccessKey。

更多说明见 README 的[安全](README.md#安全)一节。
