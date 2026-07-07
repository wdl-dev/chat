# wdl-chat

[English](README.md) | 中文

**一个构建 WDL Worker 的 WDL Worker。** wdl-chat 是一个 AI agent——它自己就部署在 WDL 上——把一句话变成运行中的 worker：MicroVM sandbox 编译 → 部署到临时 ns → 调试 + 预览。

不是平台代码，是**跑在 WDL 平台上的产品**（一个普通租户）。用开源 [`@wdl-dev/cli`](https://github.com/wdl-dev/cli) CLI（`npm i -g @wdl-dev/cli`），跟其他租户一样。平台本体见 [wdl-dev/wdl](https://github.com/wdl-dev/wdl)。线上：**https://chat.wdl.dev**。

> **定位 —— 参考 demo，不是生产级加固服务。** 这是"在 WDL 上做一个真实产品"的尽力而为示范：已部署、能用，但按 demo 维护——单测覆盖核心逻辑（解析、运行状态机、命令守卫、幂等）而非追求穷尽，Durable Object 与 VM 内 HTTP handler 没有直接测试 harness，少数边角以"已知限制"记录而非逐一修复。适合学习参考，别当作可直接投产的模板。

以 Apache-2.0 开源，见 [LICENSE](LICENSE)。工作区各 package 标记为 `private`：源码开放，但不发布到 npm。打包的第三方代码见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 仓库结构

```text
sandbox-agent/        单 session MicroVM 里的 HTTP server (Node);Lambda 从
                      docker/Dockerfile.microvm 构建镜像,这份代码跑在镜像里
workers/
  sandbox-broker/     demo ns;无状态 RPC broker(open/mint/close 单 session
                      Lambda MicroVM),是唯一持 AWS key 的组件
  chat/               demo ns;chat-worker — ChatSessionDO + ChatRunWorkflow
                      agent loop + LLM(DeepSeek)
  frontend/           demo ns(worker name=chat);单页前端(WebSocket 优先、SSE 兜底),serve chat.wdl.dev
docker/Dockerfile.microvm   MicroVM 镜像定义(由 AWS Lambda 构建,非本地 docker)
scripts/              bootstrap、deploy-workers、build-agents-md、build-microvm-image
tests/e2e/            联机 e2e(单测在各 worker 旁边)
```

## 设计文档

`CLAUDE.md` — 当前架构、设计决策、安全边界、调试入口、操作 cheat-sheet。新人先读它。
贡献流程见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 执行模型

每个 session 一台 Lambda MicroVM（Firecracker，Tokyo）。chat-worker 首次用工具时
通过 `BROKER` JSRPC service binding 调 `sandbox-broker.openSession`：broker 用自己
的 AWS key 起一台 MicroVM、铸一个短期 JWE、把 session 信息推给 VM 里的 sandbox-agent
`/init`，然后把 `{ endpoint, authToken }` 交回 chat-worker。chat-worker 之后直连
MicroVM 的公网 HTTPS endpoint（带 `X-aws-proxy-auth`）跑命令 / 部署。Close 时
`broker.closeSession` terminate 掉 VM。session 另有 6 小时硬生命周期（ns token TTL）：
超时后 router 在下次请求时惰性终止（写路径 `410`，stream/export `404`），VM 自身的
6h max-lifetime 兜底回收。无长驻池、无 lease、无 mesh。

## 部署链路

需要平台运营方给的两个凭证：(1) `demo` ns 的普通 per-ns token（你的部署凭证），(2) 一个 delegated `token-issuer` 凭证。

```text
0. npm i -g @wdl-dev/cli && wdl token   # 装 CLI + 注册 demo ns 的 per-ns token（凭证 1）
1. TOKEN_ISSUER_TOKEN=<delegated issuer> npm run bootstrap
                                        # chat-db 迁移 + 把凭证 2 存成 chat-worker secret
2. npm run deploy:sandbox-broker     # 部署 broker
   echo -n <id>  | wdl secret put AWS_ACCESS_KEY_ID --worker sandbox-broker --ns demo
   echo -n <key> | wdl secret put AWS_SECRET_ACCESS_KEY --worker sandbox-broker --ns demo
   echo -n <arn> | wdl secret put MICROVM_IMAGE_ARN --worker sandbox-broker --ns demo
3. 设 chat-worker secrets(--worker chat-worker --ns demo):
   OPERATOR_TOKEN / LLM_API_KEY / ADMIN_URL / DEMO_PASSCODE  (TOKEN_ISSUER_TOKEN 已在步骤 1 由 bootstrap 设置)
4. bash scripts/deploy-workers.sh    # 部署 chat-worker 然后 frontend(re-pin CHAT binding)
5. 访问 https://chat.wdl.dev/
```

沙箱镜像单独构建：`bash scripts/build-microvm-image.sh`（打包 `{ Dockerfile, sandbox-agent }` → `update-microvm-image`；CLI 在镜像内从 npm 安装）。
（`deploy:chat` / `deploy:frontend` 也可单独 `npm run`，但前端必须在 chat-worker 之后
重部署才能 re-pin 到新版本。）
