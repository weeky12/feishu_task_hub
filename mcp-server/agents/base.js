/**
 * 多智能体基础模块
 *
 * 所有 AI 成员共用的基础类，封装：
 * - 飞书 WebSocket 长连接
 * - 群消息解析 + @检测
 * - 对话历史（群共享，每个 agent 都能读到）
 * - 任务存储集成
 * - 防循环机制（忽略其他 Bot 的消息，除非显式 @自己）
 */

import * as lark from '@larksuiteoapi/node-sdk';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { TaskStore } from '../task-store.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 群聊对话历史文件（所有 agent 共享读写）
const HISTORY_FILE = path.join(__dirname, '../data/group-history.json');
// 最多保留最近 N 条消息作为上下文
const MAX_HISTORY = 20;

/**
 * 读取群聊历史
 * @returns {Array} 消息数组
 */
export function loadHistory() {
  try {
    if (!existsSync(HISTORY_FILE)) return [];
    return JSON.parse(readFileSync(HISTORY_FILE, 'utf-8'));
  } catch { return []; }
}

/**
 * 追加一条消息到群聊历史
 * @param {{role: string, name: string, content: string}} msg
 */
export function appendHistory(msg) {
  try {
    const history = loadHistory();
    history.push({ ...msg, timestamp: new Date().toISOString() });
    // 只保留最近 MAX_HISTORY 条
    const trimmed = history.slice(-MAX_HISTORY);
    writeFileSync(HISTORY_FILE, JSON.stringify(trimmed, null, 2));
  } catch (e) {
    console.error('[Agent Base] 写入历史失败:', e.message);
  }
}

/**
 * 将历史转换为标准 messages 格式（供各 AI API 使用）
 * @returns {Array<{role: string, content: string}>}
 */
export function buildContextMessages(systemPrompt) {
  const history = loadHistory();
  const messages = [];
  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt });
  }
  for (const h of history) {
    // 用 assistant/user 区分：其他 Bot 的发言也当 user 传入，保留 name 标记
    messages.push({
      role: 'user',
      content: `[${h.name}]: ${h.content}`
    });
  }
  return messages;
}

/**
 * BaseAgent — 所有 AI 成员继承此类
 */
export class BaseAgent {
  /**
   * @param {object} config
   * @param {string} config.name          显示名称，如 "Claude"
   * @param {string} config.role          角色描述，如 "架构师"
   * @param {string} config.systemPrompt  系统提示词（角色人设）
   * @param {string} config.appIdEnv      飞书 App ID 的环境变量名
   * @param {string} config.appSecretEnv  飞书 App Secret 的环境变量名
   * @param {string[]} config.botAppIds   所有 Bot 的 App ID 列表（防循环用）
   * @param {Function} config.callAI      async (messages) => string
   */
  constructor(config) {
    this.name = config.name;
    this.role = config.role;
    this.systemPrompt = config.systemPrompt;
    this.appId = process.env[config.appIdEnv];
    this.appSecret = process.env[config.appSecretEnv];
    this.botAppIds = config.botAppIds || [];
    this.callAI = config.callAI;
    this.store = new TaskStore();

    // 飞书客户端（用于回复消息）
    this.client = new lark.Client({
      appId: this.appId,
      appSecret: this.appSecret,
      disableTokenCache: false
    });

    // 自己的 open_id（启动后从 API 获取，用于检测 @自己）
    this.myOpenId = null;
    this._fetchMyOpenId();
  }

  /**
   * 获取自己的 open_id（用于群消息 @检测）
   */
  async _fetchMyOpenId() {
    try {
      const res = await this.client.bot.getBotInfo({});
      this.myOpenId = res.bot?.open_id || null;
      if (this.myOpenId) {
        console.log(`[${this.name}] open_id: ${this.myOpenId}`);
      }
    } catch (e) {
      console.warn(`[${this.name}] 获取 open_id 失败（群聊 @检测将降级）:`, e.message);
    }
  }

  /**
   * 回复消息
   */
  async replyText(messageId, text) {
    try {
      await this.client.im.message.reply({
        path: { message_id: messageId },
        data: { msg_type: 'text', content: JSON.stringify({ text }) }
      });
    } catch (e) {
      console.error(`[${this.name}] 回复失败:`, e.message);
    }
  }

  /**
   * 向群/用户发送新消息（主动发言，非回复）
   */
  async sendText(chatId, text) {
    try {
      await this.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({ text })
        }
      });
    } catch (e) {
      console.error(`[${this.name}] 发送消息失败:`, e.message);
    }
  }

  /**
   * 判断群消息是否 @了自己
   * 飞书 @机器人 会在 mentions 数组中包含 bot 的 open_id
   */
  _isMentioned(data) {
    const mentions = data.message?.mentions || [];
    if (this.myOpenId) {
      return mentions.some(m => m.id?.open_id === this.myOpenId);
    }
    // 降级：检查文本中是否有 @_user_ 标记（飞书格式）
    return true; // P2P 消息默认处理
  }

  /**
   * 判断消息发送者是否是已知 Bot（防止 Bot 间无限循环）
   */
  _isBotMessage(senderOpenId) {
    // 排除自己和其他已知 Bot 的 open_id
    // 注意：这里用的是 app_id，实际运行时可换成 open_id
    return false; // 暂时依赖 @检测避免循环，后续可注入 bot open_id 列表
  }

  /**
   * 处理消息核心逻辑（子类可覆盖）
   */
  async handleMessage(data) {
    const messageId = data.message.message_id;
    const chatType = data.message.chat_type || 'p2p';
    const senderOpenId = data.sender?.sender_id?.open_id || '';

    // 群聊：只响应 @自己 的消息
    if (chatType === 'group' && !this._isMentioned(data)) return;

    // 提取文本
    let text = '';
    try {
      const content = JSON.parse(data.message.content);
      text = (content.text || '').trim();
      // 清除 @标记
      text = text.replace(/@\S+/g, '').trim();
    } catch {
      await this.replyText(messageId, '无法解析消息，请发送文本');
      return;
    }

    if (!text) return;

    const chatId = data.message.chat_id;
    console.log(`[${this.name}] 收到消息: ${text.substring(0, 80)}`);

    // 记录到共享历史（用户消息）
    const senderName = data.sender?.sender_id?.user_id || '用户';
    appendHistory({ role: 'user', name: senderName, content: text });

    // 任务指令（所有 agent 都支持）
    if (text.startsWith('/new '))    return this._handleNew(messageId, text.slice(5).trim());
    if (text === '/list' || text === '/ls') return this._handleList(messageId);
    if (text.startsWith('/done '))   return this._handleDone(messageId, text.slice(6).trim());
    if (text === '/status')          return this._handleStatus(messageId);
    if (text === '/history')         return this._handleHistory(messageId);

    // 其他文本 → 调用 AI 处理
    await this.replyText(messageId, `[${this.name} · ${this.role}] 正在思考...`);
    try {
      const messages = buildContextMessages(this.systemPrompt);
      // 追加当前用户消息
      messages.push({ role: 'user', content: text });

      let reply = await this.callAI(messages);
      if (!reply) reply = '(无输出)';
      if (reply.length > 3000) reply = reply.substring(0, 3000) + '\n...(已截断)';

      // 记录自己的回复到历史
      appendHistory({ role: 'assistant', name: this.name, content: reply });

      await this.replyText(messageId, `[${this.name} · ${this.role}]\n${reply}`);
    } catch (e) {
      const msg = e.name === 'TimeoutError' ? '响应超时' : `出错: ${e.message.substring(0, 200)}`;
      console.error(`[${this.name}] AI 调用失败:`, e.message);
      await this.replyText(messageId, `[${this.name}] ${msg}`);
    }
  }

  // ── 任务指令处理（共享逻辑）──────────────────────────────

  async _handleNew(messageId, title) {
    if (!title) { await this.replyText(messageId, '请提供任务标题，例如：/new 任务名'); return; }
    try {
      const task = await this.store.createTask({ title, source: this.name.toLowerCase() });
      await this.replyText(messageId, `[${this.name}] 任务已创建\nID: ${task.id}\n标题: ${task.title}`);
    } catch (e) { await this.replyText(messageId, `创建失败: ${e.message}`); }
  }

  async _handleList(messageId) {
    try {
      const tasks = await this.store.listTasks({ limit: 10 });
      if (!tasks.length) { await this.replyText(messageId, '暂无任务'); return; }
      const PRIORITY = { urgent: '紧急', high: '高', medium: '中', low: '低' };
      const STATUS = { pending: '[待]', in_progress: '[进]', completed: '[完]', cancelled: '[取]' };
      const lines = tasks.map((t, i) => `${i + 1}. ${STATUS[t.status]}${t.priority === 'urgent' ? '[紧急]' : ''} ${t.title}\n   ID: ${t.id}`);
      await this.replyText(messageId, `任务列表（${tasks.length} 条）:\n\n${lines.join('\n\n')}`);
    } catch (e) { await this.replyText(messageId, `获取失败: ${e.message}`); }
  }

  async _handleDone(messageId, taskId) {
    if (!taskId) { await this.replyText(messageId, '请提供任务 ID'); return; }
    try {
      const task = await this.store.updateTask(taskId, { status: 'completed' });
      await this.replyText(messageId, `[${this.name}] 任务已完成: ${task.title}`);
    } catch (e) { await this.replyText(messageId, `完成失败: ${e.message}`); }
  }

  async _handleStatus(messageId) {
    try {
      const s = await this.store.getStats();
      await this.replyText(messageId, `任务统计\n总: ${s.total}  待: ${s.pending}  进行: ${s.in_progress}  完成: ${s.completed}`);
    } catch (e) { await this.replyText(messageId, `统计失败: ${e.message}`); }
  }

  async _handleHistory(messageId) {
    const history = loadHistory();
    if (!history.length) { await this.replyText(messageId, '暂无对话历史'); return; }
    const lines = history.slice(-10).map(h => `[${h.name}]: ${h.content.substring(0, 80)}`);
    await this.replyText(messageId, `最近 ${lines.length} 条对话:\n\n${lines.join('\n\n')}`);
  }

  /**
   * 启动飞书 WebSocket 长连接
   */
  start() {
    if (!this.appId || !this.appSecret) {
      console.error(`[${this.name}] 缺少 App ID 或 App Secret，跳过启动`);
      return;
    }

    const wsClient = new lark.WSClient({
      appId: this.appId,
      appSecret: this.appSecret,
      loggerLevel: lark.LoggerLevel.warn
    });

    wsClient.start({
      eventDispatcher: new lark.EventDispatcher({}).register({
        'im.message.receive_v1': async (data) => {
          try { await this.handleMessage(data); }
          catch (e) { console.error(`[${this.name}] 处理消息异常:`, e); }
        }
      })
    });

    console.log(`[${this.name}] 已启动 · 角色: ${this.role}`);
  }
}
