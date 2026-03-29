/**
 * Kimi 飞书长连接机器人
 *
 * 独立运行的进程，通过 WebSocket 长连接接收飞书用户消息
 * 指令式任务管理 + 自由文本调用 Kimi (Moonshot AI) HTTP API 处理
 *
 * 支持的指令：
 *   /new 标题     - 创建新任务
 *   /list 或 /ls  - 列出任务
 *   /done task_id - 完成任务
 *   /status       - 查看统计
 *   /detail id    - 查看任务详情
 *   其他文本       - 调用 Kimi API 处理
 */

import * as lark from '@larksuiteoapi/node-sdk';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { TaskStore } from './task-store.js';
import { FeishuNotifier } from './notifier.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '.env') });

// 初始化任务存储和通知模块（与其他机器人共享同一个 tasks.json）
const store = new TaskStore();
const notifier = new FeishuNotifier();

// 初始化飞书客户端（使用 KIMI 专用凭证）
const client = new lark.Client({
  appId: process.env.KIMI_FEISHU_APP_ID,
  appSecret: process.env.KIMI_FEISHU_APP_SECRET,
  disableTokenCache: false
});

// Kimi API 配置
const KIMI_API_URL = 'https://api.moonshot.cn/v1/chat/completions';
const KIMI_MODEL = process.env.KIMI_MODEL || 'moonshot-v1-32k';

/**
 * 优先级显示映射
 */
const PRIORITY_MAP = {
  urgent: '紧急',
  high: '高',
  medium: '中',
  low: '低'
};

/**
 * 状态显示映射
 */
const STATUS_MAP = {
  pending: '待处理',
  in_progress: '进行中',
  completed: '已完成',
  cancelled: '已取消'
};

/**
 * 回复消息
 *
 * @param {string} messageId - 原消息 ID
 * @param {string} text - 回复文本
 */
async function replyText(messageId, text) {
  try {
    await client.im.message.reply({
      path: { message_id: messageId },
      data: {
        msg_type: 'text',
        content: JSON.stringify({ text })
      }
    });
  } catch (error) {
    console.error('[Kimi机器人] 回复消息失败:', error.message);
  }
}

/**
 * 处理 /new 指令 - 创建新任务
 */
async function handleNew(messageId, title) {
  if (!title) {
    await replyText(messageId, '请提供任务标题，例如：/new 完成需求文档');
    return;
  }
  try {
    const task = await store.createTask({ title, source: 'kimi' });
    await notifier.sendTaskCard(task, '创建');
    await replyText(messageId, `任务已创建\nID: ${task.id}\n标题: ${task.title}\n优先级: ${PRIORITY_MAP[task.priority]}`);
  } catch (error) {
    await replyText(messageId, `创建任务失败: ${error.message}`);
  }
}

/**
 * 处理 /list 指令 - 列出任务
 */
async function handleList(messageId) {
  try {
    const tasks = await store.listTasks({ status: 'pending', limit: 10 });
    if (tasks.length === 0) {
      await replyText(messageId, '暂无待处理任务');
      return;
    }
    const lines = tasks.map((t, i) =>
      `${i + 1}. [${PRIORITY_MAP[t.priority]}] ${t.title}\n   ID: ${t.id}`
    );
    await replyText(messageId, `待处理任务 (${tasks.length} 条):\n\n${lines.join('\n\n')}`);
  } catch (error) {
    await replyText(messageId, `获取任务列表失败: ${error.message}`);
  }
}

/**
 * 处理 /done 指令 - 完成任务
 */
async function handleDone(messageId, taskId) {
  if (!taskId) {
    await replyText(messageId, '请提供任务 ID，例如：/done task_20260101_120000_abcd');
    return;
  }
  try {
    const task = await store.updateTask(taskId, { status: 'completed' });
    await notifier.sendTaskCard(task, '完成');
    await replyText(messageId, `任务已完成\nID: ${task.id}\n标题: ${task.title}`);
  } catch (error) {
    await replyText(messageId, `完成任务失败: ${error.message}`);
  }
}

/**
 * 处理 /status 指令 - 查看统计
 */
async function handleStatus(messageId) {
  try {
    const stats = await store.getStats();
    const text = [
      `任务统计:`,
      `  总计: ${stats.total}`,
      `  待处理: ${stats.pending}`,
      `  进行中: ${stats.in_progress}`,
      `  已完成: ${stats.completed}`,
      `  已取消: ${stats.cancelled}`
    ].join('\n');
    await replyText(messageId, text);
  } catch (error) {
    await replyText(messageId, `获取统计失败: ${error.message}`);
  }
}

/**
 * 处理 /detail 指令 - 查看任务详情
 */
async function handleDetail(messageId, taskId) {
  if (!taskId) {
    await replyText(messageId, '请提供任务 ID，例如：/detail task_20260101_120000_abcd');
    return;
  }
  try {
    const task = await store.getTask(taskId);
    const lines = [
      `任务详情:`,
      `ID: ${task.id}`,
      `标题: ${task.title}`,
      `状态: ${STATUS_MAP[task.status]}`,
      `优先级: ${PRIORITY_MAP[task.priority]}`,
      `创建时间: ${task.created_at}`,
    ];
    if (task.description) lines.push(`描述: ${task.description}`);
    if (task.tags && task.tags.length > 0) lines.push(`标签: ${task.tags.join(', ')}`);
    if (task.notes && task.notes.length > 0) {
      lines.push(`备注 (${task.notes.length} 条):`);
      task.notes.slice(-3).forEach(n => lines.push(`  - ${n.content}`));
    }
    await replyText(messageId, lines.join('\n'));
  } catch (error) {
    await replyText(messageId, `获取任务详情失败: ${error.message}`);
  }
}

/**
 * 调用 Kimi API 处理用户消息
 *
 * @param {string} messageId - 原消息 ID
 * @param {string} userMessage - 用户发来的文本
 */
async function handleKimiChat(messageId, userMessage) {
  await replyText(messageId, '[Kimi] 已收到，正在处理...');

  console.log(`[Kimi机器人] 调用 Kimi API: ${userMessage.substring(0, 100)}`);

  const apiKey = process.env.KIMI_API_KEY;
  if (!apiKey) {
    await replyText(messageId, '[Kimi] 错误：未配置 KIMI_API_KEY，请在 .env 中添加');
    return;
  }

  try {
    const response = await fetch(KIMI_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: KIMI_MODEL,
        messages: [
          { role: 'user', content: userMessage }
        ],
        temperature: 0.3,
        max_tokens: 2000
      }),
      signal: AbortSignal.timeout(60000)
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errText.substring(0, 200)}`);
    }

    const data = await response.json();
    let reply = data.choices?.[0]?.message?.content?.trim() || '(Kimi 无输出)';

    // 截断过长的回复
    if (reply.length > 3000) {
      reply = reply.substring(0, 3000) + '\n...(输出过长已截断)';
    }

    await replyText(messageId, `[Kimi]\n${reply}`);
  } catch (error) {
    const msg = error.name === 'TimeoutError'
      ? '[Kimi] 请求超时（60秒限制）'
      : `[Kimi] 请求失败: ${error.message.substring(0, 200)}`;
    console.error('[Kimi机器人] API 错误:', error.message);
    await replyText(messageId, msg);
  }
}

/**
 * 格式化时间（上海时区）
 */
function formatTime(isoTime) {
  try {
    return new Date(isoTime).toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'Asia/Shanghai'
    });
  } catch {
    return isoTime;
  }
}

/**
 * 解析并处理用户消息
 *
 * @param {object} data - 飞书消息事件数据
 */
async function handleMessage(data) {
  console.log('[Kimi机器人] 收到消息事件:', JSON.stringify(data.message, null, 2));
  const messageId = data.message.message_id;

  // 提取文本内容
  const chatType = data.message.chat_type || 'p2p';
  let text = '';
  try {
    const content = JSON.parse(data.message.content);
    text = (content.text || '').trim();
    // 群聊消息：清理 @机器人 标记
    if (chatType === 'group') {
      text = text.replace(/@_user_\d+/g, '').trim();
    }
  } catch (error) {
    console.error('[Kimi机器人] 解析消息内容失败:', error.message);
    await replyText(messageId, '无法解析消息内容，请发送文本消息');
    return;
  }

  if (!text) {
    await replyText(messageId, '[Kimi] 消息为空，请发送任务内容或使用指令（/new, /list, /done, /status, /detail）');
    return;
  }

  // 指令解析
  if (text.startsWith('/new ')) {
    const title = text.slice(5).trim();
    await handleNew(messageId, title);
  } else if (text === '/list' || text === '/ls') {
    await handleList(messageId);
  } else if (text.startsWith('/done ')) {
    const taskId = text.slice(6).trim();
    await handleDone(messageId, taskId);
  } else if (text === '/status') {
    await handleStatus(messageId);
  } else if (text.startsWith('/detail ')) {
    const taskId = text.slice(8).trim();
    await handleDetail(messageId, taskId);
  } else {
    // 非指令文本 → 调用 Kimi API 处理
    await handleKimiChat(messageId, text);
  }
}

// ============ 启动飞书 WebSocket 长连接 ============

const wsClient = new lark.WSClient({
  appId: process.env.KIMI_FEISHU_APP_ID,
  appSecret: process.env.KIMI_FEISHU_APP_SECRET,
  loggerLevel: lark.LoggerLevel.info
});

wsClient.start({
  eventDispatcher: new lark.EventDispatcher({}).register({
    'im.message.receive_v1': async (data) => {
      try {
        await handleMessage(data);
      } catch (error) {
        console.error('[Kimi机器人] 处理消息异常:', error);
      }
    }
  })
});

console.log('[Kimi机器人] 已启动，等待消息...');
console.log('[Kimi机器人] App ID:', process.env.KIMI_FEISHU_APP_ID);
console.log('[Kimi机器人] 模型:', KIMI_MODEL);
console.log('[Kimi机器人] 指令: /new, /list, /done, /status, /detail');
console.log('[Kimi机器人] 自由文本将调用 Kimi (Moonshot) API 处理');
