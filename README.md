# Feishu Task Hub

飞书 + Claude Code + Codex 双向通信任务管理中心

通过飞书机器人发消息，AI（Claude Code / Codex）自动接收、处理并回复。同时提供 MCP Server 工具集和 Web 仪表板。

## 架构

```
飞书用户
  ↓ (Lark WebSocket 长连接)
feishu-bot.js (Claude-32 机器人)
  ↓ (ws://localhost:3456/ws/bridge)
web-dashboard/server.js (WebSocket 桥)
  ↓ (写入文件队列)
mcp-server/data/feishu-inbox.json
  ↑ (MCP 工具轮询)
MCP Server (index.js) ←→ Claude Code
  ↓ (Lark REST API)
飞书用户（收到回复）

codex-bot.js (CODEX-32 机器人) → codex exec → 飞书回复
```

## 组件说明

| 组件 | 文件 | 功能 |
|------|------|------|
| MCP Server | `mcp-server/index.js` | 任务 CRUD + 飞书消息轮询/回复 |
| Claude 飞书机器人 | `mcp-server/feishu-bot.js` | 接收飞书消息 → WebSocket 桥 → Claude Code |
| Codex 飞书机器人 | `mcp-server/codex-bot.js` | 接收飞书消息 → codex exec 处理 |
| WebSocket 桥 | `web-dashboard/ws-bridge.js` | 实时消息传递 |
| 消息队列 | `mcp-server/message-queue.js` | 跨进程文件队列（proper-lockfile） |
| 飞书通知 | `mcp-server/notifier.js` | 推送任务卡片/文本到飞书 |
| 任务存储 | `mcp-server/task-store.js` | JSON 文件持久化 + 文件锁 |
| Web 仪表板 | `web-dashboard/server.js` | Express REST API + 前端界面 |

## MCP 工具列表

| 工具 | 说明 |
|------|------|
| `create_task` | 创建任务（自动推送飞书通知） |
| `update_task` | 更新任务状态/信息 |
| `list_tasks` | 列出任务（支持过滤） |
| `get_task` | 获取任务详情 |
| `add_note` | 添加任务备注 |
| `search_tasks` | 关键词搜索任务 |
| `task_stats` | 任务统计 |
| `notify_feishu` | 发送飞书通知 |
| `poll_feishu_messages` | 轮询飞书用户消息 |
| `reply_feishu_message` | 回复飞书用户消息 |

## 快速开始

### 1. 克隆项目

```bash
git clone https://github.com/weeky12/feishu_task_hub.git
cd feishu_task_hub
```

### 2. 安装依赖

```bash
cd mcp-server && npm install
cd ../web-dashboard && npm install
```

### 3. 配置飞书应用

复制环境变量模板：

```bash
cp mcp-server/.env.example mcp-server/.env
```

编辑 `mcp-server/.env`，填入你的飞书应用凭证：

```env
# Claude 飞书机器人
FEISHU_APP_ID=cli_your_app_id
FEISHU_APP_SECRET=your_app_secret
FEISHU_USER_OPEN_ID=ou_your_open_id

# Codex 飞书机器人（可选）
CODEX_FEISHU_APP_ID=cli_your_codex_app_id
CODEX_FEISHU_APP_SECRET=your_codex_app_secret
CODEX_FEISHU_USER_OPEN_ID=ou_your_open_id
```

### 4. 飞书开发者后台配置

每个飞书应用需要：

1. **启用机器人能力**
2. **事件与回调** → 添加事件 `im.message.receive_v1`（接收消息）
3. **事件与回调** → 订阅方式选 **"使用长连接接收事件/回调"**
4. **权限管理** → 开通 `im:message.p2p_msg:readonly`（读取私聊消息）
5. **发布应用**

### 5. 配置 Claude Code MCP

在 `~/.claude/.mcp.json` 中添加：

```json
{
  "mcpServers": {
    "claude-task-hub": {
      "command": "node",
      "args": ["/你的路径/feishu_task_hub/mcp-server/index.js"],
      "description": "任务管理中心 - 创建、跟踪、管理任务，支持飞书通知"
    }
  }
}
```

### 6. 启动服务

```bash
# 同时启动所有服务（Claude bot + Codex bot + Web 仪表板）
npm start

# 或分别启动
npm run bot          # Claude 飞书机器人
npm run codex-bot    # Codex 飞书机器人
npm run web          # Web 仪表板 (http://localhost:3456)
npm run mcp          # MCP Server（通常由 Claude Code 自动启动）
```

### 7. 设置自动轮询（可选）

在 Claude Code 会话中，飞书消息需要轮询才能被 Claude Code 感知。可以使用 CronCreate 设置定时轮询，或在 Claude Code 的 skill 中配置自动轮询。

## 飞书指令

在飞书私聊机器人时支持以下指令：

| 指令 | 说明 |
|------|------|
| `/new 标题` | 创建新任务 |
| `/list` 或 `/ls` | 列出任务 |
| `/done task_id` | 完成任务 |
| `/status` | 查看统计 |
| `/detail task_id` | 查看任务详情 |
| 自由文本 | Claude-32: 转发给 Claude Code 处理; CODEX-32: 调用 codex exec 处理 |

## 项目结构

```
feishu_task_hub/
├── package.json                    # 根级启动脚本
├── mcp-server/
│   ├── index.js                    # MCP Server（10个工具）
│   ├── feishu-bot.js               # Claude 飞书机器人
│   ├── codex-bot.js                # Codex 飞书机器人
│   ├── notifier.js                 # 飞书消息推送
│   ├── task-store.js               # 任务数据存储
│   ├── message-queue.js            # 文件消息队列
│   ├── package.json                # MCP 依赖
│   ├── .env.example                # 环境变量模板
│   └── data/                       # 数据目录（自动创建）
│       ├── tasks.json              # 任务数据
│       └── feishu-inbox.json       # 飞书消息队列
└── web-dashboard/
    ├── server.js                   # Express + WebSocket 桥
    ├── ws-bridge.js                # WebSocket 桥接模块
    ├── package.json                # Web 依赖
    └── public/                     # 前端资源
        ├── index.html
        ├── app.js
        └── style.css
```

## 环境要求

- Node.js >= 18.0.0
- 飞书开发者账号（创建自建应用）
- Claude Code CLI（用于 MCP 集成）
- Codex CLI（可选，用于 CODEX-32 机器人）

## 许可

MIT
