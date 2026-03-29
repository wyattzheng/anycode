# Cascade Response Retrieval

## 当前方案：Polling

通过定时轮询 `GetCascadeTrajectorySteps` 获取 cascade 的执行状态和响应内容。

### 流程

```
chat() → StartCascade → cascadeId
       → SendUserCascadeMessage(cascadeId, items, cascadeConfig)
       → loop (每 300ms):
           GetCascadeTrajectorySteps(cascadeId)
           → 解析 steps:
             - CORTEX_STEP_TYPE_USER_INPUT (用户输入)
             - CORTEX_STEP_TYPE_PLANNER_RESPONSE (AI 回复, 支持流式更新)
             - CORTEX_STEP_TYPE_CHECKPOINT (执行完成标记)
             - CORTEX_STEP_TYPE_MCP_TOOL (工具调用)
             - ...其他内置工具 step
           → 当 CHECKPOINT status=DONE → 结束轮询
```

### 优点
- 实现简单，纯 HTTP POST (JSON)
- 自然幂等，断线重连无状态

### 缺点
- 延迟：最高 300ms 才感知到新内容
- 带宽浪费：每次请求返回所有 steps，大量重复数据
- CPU：持续轮询 400 次（最多 120s）

---

## 未来方案：StreamAgentStateUpdates

官方 Antigravity 客户端使用 `StreamAgentStateUpdates` 实现实时推送，替代轮询。

### 请求格式

```
POST /exa.language_server_pb.LanguageServerService/StreamAgentStateUpdates
Content-Type: application/connect+json
connect-protocol-version: 1
x-codeium-csrf-token: <csrf>
```

### Body（Connect Protocol 二进制帧）

```
[flags: 1 byte][length: 4 bytes big-endian][JSON payload]
```

示例：
```
\x00\x00\x00\x00\x6f{"conversationId":"854f1029-...","subscriberId":"b9a9e46f-..."}
```

- `flags = 0x00` → 数据帧（非 trailer）
- `length = 0x0000006f` → JSON payload 长度 (111 bytes)
- `conversationId` = cascadeId
- `subscriberId` = 随机 UUID（标识当前订阅者）

### 响应格式

Server-streaming：响应是一系列 Connect 帧，每帧包含一个状态更新 JSON。

### 优势
- **实时推送**：无延迟，Binary 有新 step 立即推送
- **增量更新**：只发送变化部分，节省带宽
- **资源友好**：一个长连接替代数百次轮询请求

### 实现参考

需要使用 Connect protocol 的 server-streaming 客户端：
1. 发送请求（带二进制帧前缀）
2. 读取响应流，逐帧解析
3. 每个帧是一个 JSON 状态更新
4. 最后一帧是 trailer 帧（flags=0x02），表示流结束

---

## 其他相关 RPC

| RPC | 用途 |
|-----|------|
| `StartCascade` | 创建新 cascade 会话 |
| `SendUserCascadeMessage` | 发送用户消息给 cascade |
| `GetCascadeTrajectorySteps` | 获取 cascade 的所有执行步骤 |
| `GetAllCascadeTrajectories` | 获取所有 cascade 历史 |
| `CancelCascadeInvocation` | 取消正在执行的 cascade |
| `StreamAgentStateUpdates` | 实时流式推送 cascade 状态变化 |
