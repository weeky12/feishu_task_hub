#!/usr/bin/env node

/**
 * Claude Task Hub - MCP Server
 *
 * 基于 @modelcontextprotocol/sdk v0.5.0 的任务管理 MCP 服务器
 * 提供任务创建、更新、查询、搜索、统计和飞书通知功能
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { TaskStore } from "./task-store.js";
import { FeishuNotifier } from "./notifier.js";
import { MessageQueue } from "./message-queue.js";
import * as lark from "@larksuiteoapi/node-sdk";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __filename_idx = fileURLToPath(import.meta.url);
const __dirname_idx = path.dirname(__filename_idx);
dotenv.config({ path: path.join(__dirname_idx, ".env") });

// 初始化任务存储和飞书通知
const store = new TaskStore();
const notifier = new FeishuNotifier();
const messageQueue = new MessageQueue();

// 初始化飞书客户端（用于回复消息）
const larkClient = new lark.Client({
  appId: process.env.FEISHU_APP_ID,
  appSecret: process.env.FEISHU_APP_SECRET,
  disableTokenCache: false,
});

// 创建 MCP Server 实例
const server = new Server(
  {
    name: "claude-task-hub",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// ==================== 工具定义 ====================

/**
 * 注册所有可用工具的描述信息
 */
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "create_task",
        description: "创建新任务",
        inputSchema: {
          type: "object",
          properties: {
            title: {
              type: "string",
              description: "任务标题",
            },
            description: {
              type: "string",
              description: "任务描述",
            },
            priority: {
              type: "string",
              enum: ["low", "medium", "high", "urgent"],
              description: "优先级: low/medium/high/urgent",
            },
            tags: {
              type: "array",
              items: { type: "string" },
              description: "标签列表",
            },
            due_date: {
              type: "string",
              description: "截止日期，如 2026-03-30",
            },
          },
          required: ["title"],
        },
      },
      {
        name: "update_task",
        description: "更新已有任务的信息",
        inputSchema: {
          type: "object",
          properties: {
            task_id: {
              type: "string",
              description: "任务ID",
            },
            title: {
              type: "string",
              description: "新标题",
            },
            description: {
              type: "string",
              description: "新描述",
            },
            status: {
              type: "string",
              enum: ["pending", "in_progress", "completed", "cancelled"],
              description: "任务状态: pending/in_progress/completed/cancelled",
            },
            priority: {
              type: "string",
              enum: ["low", "medium", "high", "urgent"],
              description: "优先级: low/medium/high/urgent",
            },
            tags: {
              type: "array",
              items: { type: "string" },
              description: "标签列表",
            },
            due_date: {
              type: "string",
              description: "截止日期",
            },
          },
          required: ["task_id"],
        },
      },
      {
        name: "list_tasks",
        description: "列出任务，支持按状态、优先级、标签筛选",
        inputSchema: {
          type: "object",
          properties: {
            status: {
              type: "string",
              enum: ["pending", "in_progress", "completed", "cancelled"],
              description: "按状态筛选",
            },
            priority: {
              type: "string",
              enum: ["low", "medium", "high", "urgent"],
              description: "按优先级筛选",
            },
            tag: {
              type: "string",
              description: "按标签筛选",
            },
            limit: {
              type: "number",
              description: "返回数量限制，默认20",
            },
          },
        },
      },
      {
        name: "get_task",
        description: "获取单个任务的详细信息",
        inputSchema: {
          type: "object",
          properties: {
            task_id: {
              type: "string",
              description: "任务ID",
            },
          },
          required: ["task_id"],
        },
      },
      {
        name: "add_note",
        description: "为任务添加备注",
        inputSchema: {
          type: "object",
          properties: {
            task_id: {
              type: "string",
              description: "任务ID",
            },
            content: {
              type: "string",
              description: "备注内容",
            },
          },
          required: ["task_id", "content"],
        },
      },
      {
        name: "search_tasks",
        description: "搜索任务（按关键词匹配标题和描述）",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "搜索关键词",
            },
            status: {
              type: "string",
              description: "限定搜索的状态范围",
            },
          },
          required: ["query"],
        },
      },
      {
        name: "task_stats",
        description: "获取任务统计信息（各状态数量、优先级分布等）",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "notify_feishu",
        description: "发送飞书通知（当前为日志输出，飞书集成后续实现）",
        inputSchema: {
          type: "object",
          properties: {
            message: {
              type: "string",
              description: "通知消息内容",
            },
            task_id: {
              type: "string",
              description: "关联的任务ID（可选）",
            },
          },
          required: ["message"],
        },
      },
      {
        name: "poll_feishu_messages",
        description: "轮询飞书用户发来的消息，返回所有未处理的消息并清空队列",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "reply_feishu_message",
        description: "回复飞书用户的特定消息",
        inputSchema: {
          type: "object",
          properties: {
            feishu_message_id: {
              type: "string",
              description: "飞书消息ID（从 poll_feishu_messages 返回的 feishu_message_id）",
            },
            text: {
              type: "string",
              description: "回复文本内容",
            },
          },
          required: ["feishu_message_id", "text"],
        },
      },
    ],
  };
});

// ==================== 工具执行 ====================

/**
 * 处理工具调用请求
 */
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      // 创建任务
      case "create_task": {
        const task = await store.createTask({
          title: args.title,
          description: args.description,
          priority: args.priority,
          tags: args.tags,
          due_date: args.due_date,
          source: "claude-code",
        });
        // 异步推送飞书通知（不阻塞返回）
        notifier.sendTaskCard(task, '创建').catch(e => console.error('[飞书通知失败]', e.message));
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(task, null, 2),
            },
          ],
        };
      }

      // 更新任务
      case "update_task": {
        const { task_id, ...updates } = args;
        const updated = await store.updateTask(task_id, updates);
        // 状态变更时推送飞书通知
        if (updates.status) {
          const action = updates.status === 'completed' ? '完成' : '更新';
          notifier.sendTaskCard(updated, action).catch(e => console.error('[飞书通知失败]', e.message));
        }
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(updated, null, 2),
            },
          ],
        };
      }

      // 列出任务
      case "list_tasks": {
        const tasks = await store.listTasks({
          status: args.status,
          priority: args.priority,
          tag: args.tag,
          limit: args.limit || 20,
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(tasks, null, 2),
            },
          ],
        };
      }

      // 获取任务详情
      case "get_task": {
        const task = await store.getTask(args.task_id);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(task, null, 2),
            },
          ],
        };
      }

      // 添加备注
      case "add_note": {
        const task = await store.addNote(args.task_id, args.content, "claude-code");
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(task, null, 2),
            },
          ],
        };
      }

      // 搜索任务
      case "search_tasks": {
        const results = await store.searchTasks(args.query, args.status);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(results, null, 2),
            },
          ],
        };
      }

      // 任务统计
      case "task_stats": {
        const stats = await store.getStats();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(stats, null, 2),
            },
          ],
        };
      }

      // 飞书通知
      case "notify_feishu": {
        const { message, task_id } = args;

        try {
          if (task_id) {
            const task = await store.getTask(task_id);
            if (task) {
              await notifier.sendTaskCard(task, '通知');
              await notifier.sendText(message);
            } else {
              await notifier.sendText(message);
            }
          } else {
            await notifier.sendText(message);
          }
        } catch (e) {
          console.error('[飞书通知失败]', e.message);
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                message: "飞书通知已发送",
                notification: {
                  message,
                  task_id: task_id || null,
                  timestamp: new Date().toISOString(),
                },
              }, null, 2),
            },
          ],
        };
      }

      // 轮询飞书消息
      case "poll_feishu_messages": {
        const messages = await messageQueue.pollMessages();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ messages, count: messages.length }, null, 2),
            },
          ],
        };
      }

      // 回复飞书消息
      case "reply_feishu_message": {
        const { feishu_message_id, text } = args;
        try {
          await larkClient.im.message.reply({
            path: { message_id: feishu_message_id },
            data: {
              msg_type: "text",
              content: JSON.stringify({ text }),
            },
          });
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  success: true,
                  message: "飞书回复已发送",
                  feishu_message_id,
                  timestamp: new Date().toISOString(),
                }, null, 2),
              },
            ],
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  success: false,
                  error: `回复飞书消息失败: ${error.message}`,
                }, null, 2),
              },
            ],
            isError: true,
          };
        }
      }

      default:
        return {
          content: [
            {
              type: "text",
              text: `未知工具: ${name}`,
            },
          ],
          isError: true,
        };
    }
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: `执行错误: ${error.message}`,
        },
      ],
      isError: true,
    };
  }
});

// ==================== 启动服务器 ====================

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[claude-task-hub] MCP Server 已启动");
}

main().catch((error) => {
  console.error("[claude-task-hub] 启动失败:", error);
  process.exit(1);
});
