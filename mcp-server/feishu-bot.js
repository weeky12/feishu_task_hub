/**
 * 飞书长连接机器人
 *
 * 独立运行的进程，通过 WebSocket 长连接接收飞书用户消息
 * 支持指令式任务管理和自然语言快速创建任务
 *
 * 支持的指令：
 *   /new 标题     - 创建新任务
 *   /list 或 /ls  - 列出任务
 *   /done task_id - 完成任务
 *   /status       - 查看统计
 *   /detail id    - 查看任务详情
 *   /exec 任务    - 携带文件工具执行（读写文件、运行命令），消息触发即运行
 *   普通文本       - 无工具快速问答（消息触发即运行，不轮询）
 */

import * as lark from '@larksuiteoapi/node-sdk';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import WebSocket from 'ws';
import { execFile } from 'child_process';
import { TaskStore } from './task-store.js';
import { FeishuNotifier } from './notifier.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '.env') });

// 初始化任务存储和通知模块
const store = new TaskStore();
const notifier = new FeishuNotifier();

// 初始化飞书客户端（用于回复消息）
const client = new lark.Client({
  appId: process.env.FEISHU_APP_ID,
  appSecret: process.env.FEISHU_APP_SECRET,
  disableTokenCache: false
});

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
    console.error('[飞书机器人] 回复消息失败:', error.message);
  }
}

/**
 * 处理 /new 指令 - 创建新任务
 *
 * @param {string} messageId - 原消息 ID
 * @param {string} title - 任务标题
 */
async function handleNew(messageId, title) {
  if (!title || title.trim() === '') {
    await replyText(messageId, '请提供任务标题，例如: /new 修复登录页面样式问题');
    return;
  }

  try {
    const task = await store.createTask({
      title: title.trim(),
      source: 'feishu'
    });

    // 通过通知模块发送卡片
    await notifier.sendTaskCard(task, '创建');

    await replyText(
      messageId,
      `任务已创建\n` +
      `标题: ${task.title}\n` +
      `ID: ${task.id}\n` +
      `优先级: ${PRIORITY_MAP[task.priority]}\n` +
      `状态: ${STATUS_MAP[task.status]}`
    );
  } catch (error) {
    console.error('[飞书机器人] 创建任务失败:', error.message);
    await replyText(messageId, `创建任务失败: ${error.message}`);
  }
}

/**
 * 处理 /list 指令 - 列出任务
 *
 * @param {string} messageId - 原消息 ID
 */
async function handleList(messageId) {
  try {
    const tasks = await store.listTasks({ limit: 10 });

    if (tasks.length === 0) {
      await replyText(messageId, '当前没有任务');
      return;
    }

    let text = `任务列表（共 ${tasks.length} 项）:\n`;
    text += '─'.repeat(30) + '\n';

    for (const task of tasks) {
      const statusIcon = task.status === 'completed' ? '[完成]' :
                         task.status === 'in_progress' ? '[进行]' :
                         task.status === 'cancelled' ? '[取消]' : '[待办]';
      const priorityTag = task.priority === 'urgent' ? '[紧急]' :
                          task.priority === 'high' ? '[高]' : '';
      text += `${statusIcon}${priorityTag} ${task.title}\n`;
      text += `   ID: ${task.id}\n`;
    }

    await replyText(messageId, text);
  } catch (error) {
    console.error('[飞书机器人] 列出任务失败:', error.message);
    await replyText(messageId, `获取任务列表失败: ${error.message}`);
  }
}

/**
 * 处理 /done 指令 - 完成任务
 *
 * @param {string} messageId - 原消息 ID
 * @param {string} taskId - 任务 ID
 */
async function handleDone(messageId, taskId) {
  if (!taskId || taskId.trim() === '') {
    await replyText(messageId, '请提供任务 ID，例如: /done task_20260326_120000_abcd');
    return;
  }

  try {
    const task = await store.updateTask(taskId.trim(), { status: 'completed' });

    // 通过通知模块发送完成卡片
    await notifier.sendTaskCard(task, '完成');

    await replyText(
      messageId,
      `任务已完成\n` +
      `标题: ${task.title}\n` +
      `ID: ${task.id}`
    );
  } catch (error) {
    console.error('[飞书机器人] 完成任务失败:', error.message);
    await replyText(messageId, `完成任务失败: ${error.message}`);
  }
}

/**
 * 处理 /status 指令 - 查看统计
 *
 * @param {string} messageId - 原消息 ID
 */
async function handleStatus(messageId) {
  try {
    const stats = await store.getStats();

    const text =
      `任务统计\n` +
      '─'.repeat(20) + '\n' +
      `总任务数: ${stats.total}\n` +
      `待处理: ${stats.pending}\n` +
      `进行中: ${stats.in_progress}\n` +
      `已完成: ${stats.completed}\n` +
      `已取消: ${stats.cancelled}\n` +
      `今日新建: ${stats.today_created}\n` +
      `紧急待办: ${stats.urgent}`;

    await replyText(messageId, text);
  } catch (error) {
    console.error('[飞书机器人] 获取统计失败:', error.message);
    await replyText(messageId, `获取统计失败: ${error.message}`);
  }
}

/**
 * 处理 /detail 指令 - 查看任务详情
 *
 * @param {string} messageId - 原消息 ID
 * @param {string} taskId - 任务 ID
 */
async function handleDetail(messageId, taskId) {
  if (!taskId || taskId.trim() === '') {
    await replyText(messageId, '请提供任务 ID，例如: /detail task_20260326_120000_abcd');
    return;
  }

  try {
    const task = await store.getTask(taskId.trim());

    if (!task) {
      await replyText(messageId, `任务不存在: ${taskId}`);
      return;
    }

    let text =
      `任务详情\n` +
      '─'.repeat(20) + '\n' +
      `标题: ${task.title}\n` +
      `ID: ${task.id}\n` +
      `状态: ${STATUS_MAP[task.status] || task.status}\n` +
      `优先级: ${PRIORITY_MAP[task.priority] || task.priority}\n` +
      `来源: ${task.source}\n` +
      `创建时间: ${formatTime(task.created_at)}\n` +
      `更新时间: ${formatTime(task.updated_at)}`;

    if (task.description) {
      text += `\n描述: ${task.description}`;
    }

    if (task.tags && task.tags.length > 0) {
      text += `\n标签: ${task.tags.join(', ')}`;
    }

    if (task.due_date) {
      text += `\n截止日期: ${task.due_date}`;
    }

    if (task.completed_at) {
      text += `\n完成时间: ${formatTime(task.completed_at)}`;
    }

    // 显示最近备注（最多 3 条）
    if (task.notes && task.notes.length > 0) {
      text += '\n\n最近备注:';
      const recentNotes = task.notes.slice(-3);
      for (const note of recentNotes) {
        text += `\n  [${formatTime(note.created_at)}] ${note.content}`;
      }
    }

    await replyText(messageId, text);
  } catch (error) {
    console.error('[飞书机器人] 获取任务详情失败:', error.message);
    await replyText(messageId, `获取任务详情失败: ${error.message}`);
  }
}

/**
 * 格式化 ISO 时间戳为可读格式
 *
 * @param {string} isoTime - ISO 格式时间戳
 * @returns {string} 格式化后的时间字符串
 */
function formatTime(isoTime) {
  if (!isoTime) return '-';
  try {
    const date = new Date(isoTime);
    return date.toLocaleString('zh-CN', {
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
 * 调用 Claude 处理消息（主动触发，非轮询）
 *
 * 消息到来时才 spawn Claude 进程，处理完立即退出，闲时零消耗。
 *
 * @param {string} messageId - 飞书消息 ID
 * @param {string} text      - 用户消息内容
 * @param {boolean} withTools - true = 携带文件工具（/exec 模式），false = 纯问答
 */
async function handleClaudeExec(messageId, text, withTools) {
  const claudePath = process.platform === 'win32'
    ? 'C:/Users/Administrator/AppData/Roaming/npm/claude.cmd'
    : 'claude';

  const modeLabel = withTools ? 'Claude (工具模式)' : 'Claude';
  await replyText(messageId, `[${modeLabel}] 已收到，正在处理...`);
  console.log(`[飞书机器人] 触发 Claude (withTools=${withTools}): ${text.substring(0, 100)}`);

  // withTools=true 时开放文件读写和命令执行工具
  const args = withTools
    ? ['-p', text, '--allowedTools', 'Read,Write,Edit,Bash,Glob,Grep', '--dangerously-skip-permissions']
    : ['-p', text];

  const timeout = withTools ? 300000 : 120000; // 工具模式允许 5 分钟

  execFile(claudePath, args, {
    timeout,
    maxBuffer: 2 * 1024 * 1024,
    shell: process.platform === 'win32',
    cwd: path.join(__dirname, '..')
  }, async (error, stdout) => {
    try {
      let reply;
      if (error) {
        reply = error.killed
          ? `[${modeLabel}] 处理超时（${timeout / 60000} 分钟限制）`
          : `[${modeLabel}] 处理失败: ${error.message.substring(0, 200)}`;
      } else {
        reply = (stdout || '').trim() || '(无输出)';
      }
      if (reply.length > 3000) reply = reply.substring(0, 3000) + '\n...(输出过长已截断)';
      await replyText(messageId, reply);
    } catch (replyError) {
      console.error('[飞书机器人] 回复失败:', replyError.message);
    }
  });
}

/**
 * 解析并处理用户消息
 *
 * @param {object} data - 飞书消息事件数据
 */
async function handleMessage(data) {
  console.log('[飞书机器人] 收到消息事件:', JSON.stringify(data.message, null, 2));
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
    console.error('[飞书机器人] 解析消息内容失败:', error.message);
    await replyText(messageId, '无法解析消息内容，请发送文本消息');
    return;
  }

  if (!text) {
    await replyText(messageId, '消息为空，请发送任务内容或使用指令（/new, /list, /done, /status, /detail）');
    return;
  }

  // 指令解析
  if (text.startsWith('/new ')) {
    // 创建新任务
    const title = text.slice(5).trim();
    await handleNew(messageId, title);
  } else if (text === '/list' || text === '/ls') {
    // 列出任务
    await handleList(messageId);
  } else if (text.startsWith('/done ')) {
    // 完成任务
    const taskId = text.slice(6).trim();
    await handleDone(messageId, taskId);
  } else if (text === '/status') {
    // 查看统计
    await handleStatus(messageId);
  } else if (text.startsWith('/detail ')) {
    // 查看任务详情
    const taskId = text.slice(8).trim();
    await handleDetail(messageId, taskId);
  } else if (text.startsWith('/exec ')) {
    // /exec 前缀 → 携带文件工具的 Claude（读写文件、执行命令）
    const task = text.slice(6).trim();
    await handleClaudeExec(messageId, task, true);
  } else {
    // 普通文本 → 无工具 claude -p（快速问答，不消耗额外资源）
    await handleClaudeExec(messageId, text, false);
  }
}

// ============ WebSocket 桥接客户端 ============

const WS_BRIDGE_URL = 'ws://localhost:3456/ws/bridge';
let wsBridge = null;
let wsReconnectDelay = 3000;
const WS_MAX_DELAY = 30000;

/**
 * 连接 WebSocket 桥（自动重连）
 */
function connectBridge() {
  try {
    wsBridge = new WebSocket(WS_BRIDGE_URL);

    wsBridge.on('open', () => {
      console.log('[飞书机器人] 已连接 WebSocket 桥');
      wsReconnectDelay = 3000;
      wsBridge.send(JSON.stringify({ type: 'register', role: 'feishu-bot' }));
    });

    wsBridge.on('close', () => {
      console.log(`[飞书机器人] WebSocket 桥断开，${wsReconnectDelay / 1000}秒后重连...`);
      wsBridge = null;
      setTimeout(connectBridge, wsReconnectDelay);
      wsReconnectDelay = Math.min(wsReconnectDelay * 2, WS_MAX_DELAY);
    });

    wsBridge.on('error', (err) => {
      console.error('[飞书机器人] WebSocket 桥错误:', err.message);
    });

    wsBridge.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'ack') {
          console.log(`[飞书机器人] 消息已确认入队: ${msg.message_id}`);
        }
      } catch {
        // 忽略
      }
    });
  } catch (err) {
    console.error('[飞书机器人] WebSocket 连接失败:', err.message);
    setTimeout(connectBridge, wsReconnectDelay);
  }
}

/**
 * 转发消息到 WebSocket 桥
 *
 * @param {object} data - 消息数据
 * @returns {boolean} 是否成功转发
 */
function forwardToBridge(data) {
  if (wsBridge && wsBridge.readyState === WebSocket.OPEN) {
    wsBridge.send(JSON.stringify({
      type: 'feishu_message',
      payload: data
    }));
    return true;
  }
  return false;
}

// 启动桥接连接
connectBridge();

// ============ 启动飞书 WebSocket 长连接 ============

const wsClient = new lark.WSClient({
  appId: process.env.FEISHU_APP_ID,
  appSecret: process.env.FEISHU_APP_SECRET,
  loggerLevel: lark.LoggerLevel.info
});

wsClient.start({
  eventDispatcher: new lark.EventDispatcher({}).register({
    'im.message.receive_v1': async (data) => {
      try {
        await handleMessage(data);
      } catch (error) {
        console.error('[飞书机器人] 处理消息异常:', error);
      }
    }
  })
});

console.log('飞书机器人已启动，等待消息...');
