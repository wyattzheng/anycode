# AnyCode

AnyCode 是一个语音驱动的 AI 编程平台。用户通过语音与 AI 对话，AI 直接操控一个 web 项目来呈现编程界面和结果。让编程可以发生在任何地方、任何设备上——无需键盘，只需你的声音。

## 核心理念：Mobile-First

> 传统编程工具被绑定在桌面端，AnyCode 的核心价值是**让编程从桌面解放出来**。

- **移动端优先设计** — 所有界面和交互都以手机/平板为第一优先级进行设计，桌面端是扩展适配
- **语音驱动** — 手机上没有高效键盘，但有麦克风。语音是移动端最自然的编程输入方式
- **AI 生成界面** — 用户不需要操控复杂的 IDE UI，AI 根据需求动态生成最适合当前任务的界面
- **触摸友好** — 所有可交互元素都需适配触摸操作，避免依赖鼠标悬停等桌面端交互模式

## 架构概览

```
┌─────────────────────────────────────────┐
│                 App (Web App)             │
│                                         │
│  ┌───────────────────────────────────┐  │
│  │         主界面 (Main View)         │  │
│  │   全屏 web 视图，由 AI 操控的      │  │
│  │   前端项目，AI 决定展示什么界面     │  │
│  │                                   │  │
│  │  ┌─────────────────┐             │  │
│  │  │  次要界面         │             │  │
│  │  │  (Conversation)  │             │  │
│  │  │  半透明浮层       │             │  │
│  │  │  与 AI 对话       │             │  │
│  │  └─────────────────┘             │  │
│  └───────────────────────────────────┘  │
│          🎤 全局语音输入                    │
└──────────────┬──────────────────────────┘
               │ WebSocket
┌──────────────▼──────────────────────────┐
│        Server (@any-code/server)         │
│  · 语音识别 & 转发                       │
│  · WebSocket 桥接                       │
│  · Web 项目管理与实时推送                │
│               │                          │
│               │ opencode client API       │
│               ▼                          │
│  ┌────────────────────────┐              │
│  │   opencode (AI Agent)  │              │
│  │  · AI 对话 & 工具调用   │              │
│  │  · 文件系统 & 终端操作  │              │
│  └────────────────────────┘              │
└──────────────────────────────────────────┘
```

## 界面设计

> 所有界面元素都遵循 **mobile-first** 原则：先为小屏幕设计，再向大屏幕扩展。

### 主界面 (Main View)

- **全屏**占满整个视窗，高度自定义
- 本质是渲染一个 **AI 操控的前端 web 项目**
- 这个 web 项目从空项目开始，AI 通过生成/修改前端代码来动态构建界面
- AI 根据用户需求决定展示什么界面供用户操作
- **底部固定 Tab 栏**：
  - Agent 的 web 项目对外暴露一个 **tablist JSON 接口**，返回当前可用的 Tab 列表（名称 + 路由地址）
  - App 读取 tablist，渲染底部 Tab 栏
  - 点击 Tab → 访问对应的路由地址，在主界面中展示该页面
  - Agent 可以动态增删 Tab（通过修改 web 项目代码和路由）
  - **Tab 栏是整个界面唯一的刚性固定元素**，不占用太多空间，同时承载页面导航和对话控制入口。

- **默认框架约束**：由于 AnyCode 的核心目的是编程，所以默认至少需要包含以下**刚性 Tab**：
  - 📁 **文件浏览** — 目录结构查看 + 文件内容查看
  - 📝 **变更查看** — 变更文件列表 + 变更文件 diff view
  - 👁 **预览** — AI 操控的 web 项目的预览界面。映射到 Agent web 项目的某个路由。当 AI 尚未生成预览内容时，显示占位提示（"等待 AI 填充预览界面..."）
  - 这三个 Tab **硬编码在 App 中**，不依赖 AI 生成
  - Agent 可以在此基础上动态增删其他 Tab

### 次要界面 (Conversation Overlay)

- **半透明浮层**，叠加在主界面之上
- 只占用屏幕的**一小部分区域**（如右下角或底部）
- 用于与 AI 进行对话沟通
- 可展开/收起/拖拽调整位置
- 通过 **Tab 栏上的按钮**控制展开/收起


### 输入方式

- **语音输入（主要）**：对讲机模式，按住说话，松手发送
  - 按住麦克风按钮 → 开始录音 → 说话 → 松手 → 自动发送给 AI
  - 短按（未录到有效内容）不发送
  - 录音过程中有视觉反馈（按钮变色 + 脉冲动画）
- **文本输入（备选）**：在对话面板中打字发送

## Agent — 接入 opencode

- **不自维护 Agent**，直接接入 [opencode](https://github.com/opencode-ai/opencode)。opencode 本身就是 client/server 架构，提供完整的 AI 编程能力（对话、工具调用、文件操作、终端执行等），非常适合作为 AnyCode 的后端 Agent。

- **接入方式**：Server 通过 opencode 的 client API 与其通信，将用户的语音/文本指令转发给 opencode，并将 opencode 的响应（文件变更、终端输出等）实时推送给 App。

- **优势**：
  - 社区维护，能力持续迭代
  - 已有成熟的工具链（文件读写、终端、代码搜索等）
  - client/server 分离，Server 只需做桥接和移动端适配
  - AnyCode 专注于移动端 UI/UX 和语音交互，不重复造轮子

## Server (@any-code/server)

### 安装与配置

```bash
npm i @any-code/server -g
any-code-server
# 首次启动进入引导配置：
#   - AI 服务 provider 选择
#   - API Key 填写
#   - 端口配置
#   - 其他参数
```

### 核心职责

1. **opencode 桥接** — 通过 opencode client API 转发用户指令，接收 Agent 响应（文件变更、终端输出等）
2. **Web 项目管理** — 维护 AI 操控的前端项目，实时推送代码变更到 Client 进行渲染
3. **语音识别** — 接收 Client 的音频流，通过 Provider 适配器转发到语音服务（或本地模型），返回统一格式的文字结果
4. **WebSocket 服务** — 与 Client 保持实时双向通信

### 部署方式

- **远端部署**：安装在云服务器上，Client 通过公网访问，适合移动端随时随地使用

## 技术栈

### App

- **Vite + React + TypeScript**
- **Web App**（先做 Web，后续可通过 Capacitor 包装为原生应用）
- **响应式设计**：CSS mobile-first 媒体查询，以移动端为基准向上适配
- 语音采集：Web Audio API 录制 PCM 音频，通过 WebSocket 发送到 Server
- 实时通信：WebSocket
- 主界面渲染：iframe 或 Shadow DOM 隔离的 web 视图
- 触摸手势支持（滑动、长按等移动端常见交互）

### Server

- **Node.js + TypeScript**
- **tsup** 打包（基于 esbuild，适合 CLI 包构建）
- WebSocket 服务（ws）

## 项目结构

> **原则：先平铺，后拆分。** 每个包从平铺的几个文件开始（如 `socket.ts`、`speech.ts`、`index.ts`），当复杂度增长到有必要时，再将逻辑拆分为子目录或子包。

```
any-code/
├── packages/
│   ├── app/                 # Web App（移动端优先 UI）
│   │   ├── src/
│   │   └── index.html
│   │
│   └── server/              # @any-code/server（通信与桥接层）
│       ├── src/
│       └── bin/
│           └── cli.ts       # CLI 入口
│
├── GEMINI.md                # 项目规范（本文件）
├── LICENSE
└── package.json             # monorepo 根配置 (pnpm workspace)
```

## Git 规范

使用 [Conventional Commits](https://www.conventionalcommits.org/)，**所有 commit 消息必须使用英文**。

```
<type>(<scope>): <description>
```

每次 commit 后可以顺手 `git push`。
