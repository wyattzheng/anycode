# AnyCode

*走在路上突然有了灵感？掏出手机，语音告诉 Agent 你的想法，然后把手机揣回口袋。*

*Agent 在云端默默实现，你随时可以打开浏览器验收成果、实时预览、继续迭代——一切状态都还在。*

- **语音/文字输入** — 同时支持舒适的文字编辑与语音驱动，按住说话松手即发
- **多窗口支持** — 同时打开多个工作窗口，自由切换不同项目和任务
- **简洁界面** — 干净克制，只呈现必要的改动信息，不打扰思路
- **随时恢复** — 会话状态持久化，关掉浏览器再打开，一切还在原处
- **可选 Agent** — 支持 Claude Code / Codex 等作为工作 Agent

> Agent 时代，随身携带的移动设备拥有更大的潜力。

## 安装

通过 Docker 一键部署：

```bash
docker stop anycode && docker rm anycode && \
docker pull anycodex/anycode:latest && \
docker run -d \
  --name anycode \
  --restart unless-stopped \
  -p 2223:2223 \
  -p 2224:2224 \
  -v /etc/letsencrypt:/etc/letsencrypt:ro \
  -e PORT=2223 \
  -e TLS_CERT=/etc/letsencrypt/live/<your-domain>/fullchain.pem \
  -e TLS_KEY=/etc/letsencrypt/live/<your-domain>/privkey.pem \
  -e PROVIDER=openai \
  -e AGENT=anycode \
  -e MODEL=<model-name> \
  -e API_KEY=<your-api-key> \
  -e BASE_URL=<your-api-base-url> \
  anycodex/anycode:latest
```

| 环境变量 | 说明 | 示例 |
|---------|------|------|
| `PORT` | 服务端口 | `2223` |
| `TLS_CERT` / `TLS_KEY` | TLS 证书路径（用于 HTTPS） | |
| `PROVIDER` | AI 服务提供商 | `openai` |
| `AGENT` | Agent 类型 | `anycode` |
| `MODEL` | 模型名称 | `gpt-4o` |
| `API_KEY` | API 密钥 | `sk-xxxxxxxx` |
| `BASE_URL` | API 地址 | `https://api.openai.com/v1` |

## License

MIT
