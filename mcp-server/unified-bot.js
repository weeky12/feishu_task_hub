/**
 * 统一飞书机器人 — 单 App 多 AI 路由
 *
 * 一个飞书 App 搞定所有 AI，新增 AI 只需在 AI_PROVIDERS 加一项 + .env 加 API Key。
 *
 * 使用方式：
 *   /kimi 问题          → Kimi (Moonshot) API
 *   /minimax 问题       → MiniMax API
 *   /claude 问题        → Claude CLI
 *   /codex 问题         → Codex CLI
 *   普通文本             → DEFAULT_AI（默认 claude，.env 可配置）
 *   /ai                 → 查看可用 AI 列表
 *
 * 任务指令（与 AI 无关）：
 *   /new 标题   /list   /done id   /status   /detail id
 */

import * as lark from '@larksuiteoapi/node-sdk';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process';
import WebSocket from 'ws';
import { TaskStore } from './task-store.js';
import { FeishuNotifier } from './notifier.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '.env') });

const store = new TaskStore();
const notifier = new FeishuNotifier();

// 复用主飞书 App（不需要单独创建 App）
const client = new lark.Client({
  appId: process.env.FEISHU_APP_ID,
  appSecret: process.env.FEISHU_APP_SECRET,
  disableTokenCache: false
});

// ============ AI 提供者注册表 ============
// 新增 AI：在此加一项，.env 加对应 API Key，完成。

const AI_PROVIDERS = {

  claude: {
    name: 'Claude',
    description: 'Anthropic Claude (本地 CLI)',
    async call(userMessage) {
      return new Promise((resolve) => {
        const claudePath = process.platform === 'win32'
          ? 'C:/Users/Administrator/AppData/Roaming/npm/claude.cmd'
          : 'claude';
        execFile(claudePath, ['-p', userMessage], {
          timeout: 120000,
          maxBuffer: 1024 * 1024,
          shell: process.platform === 'win32',
          cwd: path.join(__dirname, '..')
        }, (error, stdout) => {
          if (error) {
            resolve(error.killed ? '处理超时（2分钟限制）' : `调用失败: ${error.message.substring(0, 200)}`);
          } else {
            resolve((stdout || '').trim() || '(无输出)');
          }
        });
      });
    }
  },

  codex: {
    name: 'Codex',
    description: 'OpenAI Codex CLI',
    async call(userMessage) {
      return new Promise((resolve) => {
        execFile('C:/Users/Administrator/AppData/Roaming/npm/codex.cmd', [
          'exec', '--full-auto', '--skip-git-repo-check', '--ephemeral', userMessage
        ], {
          timeout: 120000,
          maxBuffer: 1024 * 1024,
          shell: true
        }, (error, stdout) => {
          if (error) {
            resolve(error.killed ? '执行超时（2分钟限制）' : `执行失败: ${error.message.substring(0, 200)}`);
          } else {
            resolve(stdout.trim() || '(无输出)');
          }
        });
      });
    }
  },

  kimi: {
    name: 'Kimi',
    description: 'Moonshot AI (moonshot-v1-32k)',
    async call(userMessage) {
      const apiKey = process.env.KIMI_API_KEY;
      if (!apiKey) return '未配置 KIMI_API_KEY，请在 .env 中添加';
      const model = process.env.KIMI_MODEL || 'moonshot-v1-32k';
      const res = await fetch('https://api.moonshot.cn/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: userMessage }], temperature: 0.3, max_tokens: 2000 }),
        signal: AbortSignal.timeout(60000)
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).substring(0, 200)}`);
      const data = await res.json();
      return data.choices?.[0]?.message?.content?.trim() || '(无输出)';
    }
  },

  minimax: {
    name: 'MiniMax',
    description: 'MiniMax-Text-01',
    async call(userMessage) {
      const apiKey = process.env.MINIMAX_API_KEY;
      const groupId = process.env.MINIMAX_GROUP_ID;
      if (!apiKey) return '未配置 MINIMAX_API_KEY，请在 .env 中添加';
      if (!groupId) return '未配置 MINIMAX_GROUP_ID，请在 .env 中添加';
      const model = process.env.MINIMAX_MODEL || 'MiniMax-Text-01';
      const res = await fetch(`https://api.minimax.chat/v1/text/chatcompletion_v2?GroupId=${groupId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({ model, messages: [{ role: 'user', name: 'user', content: userMessage }], temperature: 0.3, max_tokens: 2000, stream: false }),
        signal: AbortSignal.timeout(60000)
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).substring(0, 200)}`);
      const data = await res.json();
      return data.choices?.[0]?.message?.content?.trim() || '(无输出)';
    }
  },

  // ── 在此追加新 AI ──────────────────────────────────────────
  // deepseek: {
  //   name: 'DeepSeek',
  //   description: 'DeepSeek-V3',
  //   async call(userMessage) {
  //     const apiKey = process.env.DEEPSEEK_API_KEY;
  //     if (!apiKey) return '未配置 DEEPSEEK_API_KEY';
  //     const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
  //       method: 'POST',
  //       headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
  //       body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'user', content: userMessage }] }),
  //       signal: AbortSignal.timeout(60000)
  //     });
  //     if (!res.ok) throw new Error(`HTTP ${res.status}`);
  //     const data = await res.json();
  //     return data.choices?.[0]?.message?.content?.trim() || '(无输出)';
  //   }
  // },
  // ───────────────────────────────────────────────────────────
};

const DEFAULT_AI = process.env.DEFAULT_AI || 'claude';

// ============ 工具函数 ============

const PRIORITY_MAP = { urgent: '紧急', high: '高', medium: '中', low: '低' };
const STATUS_MAP = { pending: '待处理', in_progress: '进行中', completed: '已完成', cancelled: '已取消' };

async function replyText(messageId, text) {
  try {
    await client.im.message.reply({
      path: { message_id: messageId },
      data: { msg_type: 'text', content: JSON.stringify({ text }) }
    });
  } catch (error) {
    console.error('[统一机器人] 回复失败:', error.message);
  }
}

function formatTime(isoTime) {
  if (!isoTime) return '-';
  try {
    return new Date(isoTime).toLocaleString('zh-CN', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Shanghai'
    });
  } catch { return isoTime; }
}

// ============ 任务指令处理 ============

async function handleNew(messageId, title) {
  if (!title) { await replyText(messageId, '请提供任务标题，例如：/new 修复登录页面'); return; }
  try {
    const task = await store.createTask({ title, source: 'feishu' });
    await notifier.sendTaskCard(task, '创建');
    await replyText(messageId, `任务已创建\nID: ${task.id}\n标题: ${task.title}\n优先级: ${PRIORITY_MAP[task.priority]}`);
  } catch (e) { await replyText(messageId, `创建失败: ${e.message}`); }
}

async function handleList(messageId) {
  try {
    const tasks = await store.listTasks({ limit: 10 });
    if (!tasks.length) { await replyText(messageId, '暂无任务'); return; }
    const lines = tasks.map((t, i) => {
      const s = t.status === 'completed' ? '[完成]' : t.status === 'in_progress' ? '[进行]' : t.status === 'cancelled' ? '[取消]' : '[待办]';
      const p = t.priority === 'urgent' ? '[紧急]' : t.priority === 'high' ? '[高]' : '';
      return `${i + 1}. ${s}${p} ${t.title}\n   ID: ${t.id}`;
    });
    await replyText(messageId, `任务列表（${tasks.length} 条）:\n\n${lines.join('\n\n')}`);
  } catch (e) { await replyText(messageId, `获取失败: ${e.message}`); }
}

async function handleDone(messageId, taskId) {
  if (!taskId) { await replyText(messageId, '请提供任务 ID，例如：/done task_...'); return; }
  try {
    const task = await store.updateTask(taskId, { status: 'completed' });
    await notifier.sendTaskCard(task, '完成');
    await replyText(messageId, `任务已完成\nID: ${task.id}\n标题: ${task.title}`);
  } catch (e) { await replyText(messageId, `完成失败: ${e.message}`); }
}

async function handleStatus(messageId) {
  try {
    const s = await store.getStats();
    await replyText(messageId, `任务统计\n总计: ${s.total}\n待处理: ${s.pending}\n进行中: ${s.in_progress}\n已完成: ${s.completed}\n已取消: ${s.cancelled}`);
  } catch (e) { await replyText(messageId, `获取统计失败: ${e.message}`); }
}

async function handleDetail(messageId, taskId) {
  if (!taskId) { await replyText(messageId, '请提供任务 ID'); return; }
  try {
    const t = await store.getTask(taskId);
    if (!t) { await replyText(messageId, `任务不存在: ${taskId}`); return; }
    let text = `任务详情\n标题: ${t.title}\nID: ${t.id}\n状态: ${STATUS_MAP[t.status]}\n优先级: ${PRIORITY_MAP[t.priority]}\n创建: ${formatTime(t.created_at)}`;
    if (t.description) text += `\n描述: ${t.description}`;
    if (t.tags?.length) text += `\n标签: ${t.tags.join(', ')}`;
    if (t.notes?.length) { text += `\n备注:`; t.notes.slice(-3).forEach(n => { text += `\n  - ${n.content}`; }); }
    await replyText(messageId, text);
  } catch (e) { await replyText(messageId, `获取详情失败: ${e.message}`); }
}

// ============ AI 路由处理 ============

async function handleAiCall(messageId, aiKey, userMessage) {
  const provider = AI_PROVIDERS[aiKey];
  if (!provider) {
    const available = Object.keys(AI_PROVIDERS).join(', ');
    await replyText(messageId, `未知 AI: ${aiKey}\n可用: ${available}`);
    return;
  }

  await replyText(messageId, `[${provider.name}] 已收到，正在处理...`);
  console.log(`[统一机器人] 路由到 ${provider.name}: ${userMessage.substring(0, 100)}`);

  try {
    let reply = await provider.call(userMessage);
    if (reply.length > 3000) reply = reply.substring(0, 3000) + '\n...(输出过长已截断)';
    await replyText(messageId, `[${provider.name}]\n${reply}`);
  } catch (error) {
    const msg = error.name === 'TimeoutError' ? '请求超时（60秒）' : `请求失败: ${error.message.substring(0, 200)}`;
    console.error(`[统一机器人] ${provider.name} 错误:`, error.message);
    await replyText(messageId, `[${provider.name}] ${msg}`);
  }
}

// ============ 消息分发 ============

async function handleMessage(data) {
  const messageId = data.message.message_id;
  const chatType = data.message.chat_type || 'p2p';

  let text = '';
  try {
    const content = JSON.parse(data.message.content);
    text = (content.text || '').trim();
    if (chatType === 'group') text = text.replace(/@_user_\d+/g, '').trim();
  } catch {
    await replyText(messageId, '无法解析消息，请发送文本');
    return;
  }

  if (!text) return;

  console.log(`[统一机器人] 收到消息: ${text.substring(0, 80)}`);

  // 任务指令
  if (text.startsWith('/new '))    return handleNew(messageId, text.slice(5).trim());
  if (text === '/list' || text === '/ls') return handleList(messageId);
  if (text.startsWith('/done '))   return handleDone(messageId, text.slice(6).trim());
  if (text === '/status')          return handleStatus(messageId);
  if (text.startsWith('/detail ')) return handleDetail(messageId, text.slice(8).trim());

  // /ai — 查看可用 AI
  if (text === '/ai') {
    const list = Object.entries(AI_PROVIDERS)
      .map(([k, v]) => `  /${k} — ${v.description}`)
      .join('\n');
    const defaultLabel = AI_PROVIDERS[DEFAULT_AI]?.name || DEFAULT_AI;
    await replyText(messageId, `可用 AI:\n${list}\n\n默认: ${defaultLabel}（直接发文本即调用）\n切换默认：在 .env 设置 DEFAULT_AI=kimi`);
    return;
  }

  // AI 路由：/kimi xxx  /minimax xxx  /claude xxx ...
  const aiMatch = text.match(/^\/(\w+)\s+([\s\S]+)$/);
  if (aiMatch && AI_PROVIDERS[aiMatch[1]]) {
    return handleAiCall(messageId, aiMatch[1], aiMatch[2].trim());
  }

  // 未知斜杠指令提示
  if (text.startsWith('/')) {
    const cmds = '/new, /list, /done, /status, /detail, /ai, /' + Object.keys(AI_PROVIDERS).join(', /');
    await replyText(messageId, `未知指令。可用指令:\n${cmds}`);
    return;
  }

  // 普通文本 → 默认 AI
  return handleAiCall(messageId, DEFAULT_AI, text);
}

// ============ WebSocket 桥（可选，供 Web Dashboard 使用）============

const WS_BRIDGE_URL = 'ws://localhost:3456/ws/bridge';
let wsBridge = null;
let wsReconnectDelay = 3000;

function connectBridge() {
  try {
    wsBridge = new WebSocket(WS_BRIDGE_URL);
    wsBridge.on('open', () => {
      console.log('[统一机器人] 已连接 WebSocket 桥');
      wsReconnectDelay = 3000;
      wsBridge.send(JSON.stringify({ type: 'register', role: 'unified-bot' }));
    });
    wsBridge.on('close', () => {
      wsBridge = null;
      setTimeout(connectBridge, wsReconnectDelay);
      wsReconnectDelay = Math.min(wsReconnectDelay * 2, 30000);
    });
    wsBridge.on('error', () => {});
  } catch { setTimeout(connectBridge, wsReconnectDelay); }
}
connectBridge();

// ============ 启动飞书 WebSocket 长连接 ============

const wsClient = new lark.WSClient({
  appId: process.env.FEISHU_APP_ID,
  appSecret: process.env.FEISHU_APP_SECRET,
  loggerLevel: lark.LoggerLevel.warn
});

wsClient.start({
  eventDispatcher: new lark.EventDispatcher({}).register({
    'im.message.receive_v1': async (data) => {
      try { await handleMessage(data); }
      catch (error) { console.error('[统一机器人] 处理消息异常:', error); }
    }
  })
});

const aiList = Object.entries(AI_PROVIDERS).map(([k, v]) => `${v.name}(/${k})`).join(', ');
console.log('[统一机器人] 已启动，等待消息...');
console.log(`[统一机器人] 可用 AI: ${aiList}`);
console.log(`[统一机器人] 默认 AI: ${AI_PROVIDERS[DEFAULT_AI]?.name || DEFAULT_AI}`);
console.log('[统一机器人] 发送 /ai 查看使用帮助');
