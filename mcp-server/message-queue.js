/**
 * 飞书消息队列模块
 *
 * 基于文件的跨进程消息队列，使用 proper-lockfile 保护并发访问
 * 用于 feishu-bot (WebSocket) → MCP Server (poll) 的消息传递
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import lockfile from 'proper-lockfile';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.join(__dirname, 'data');
const INBOX_FILE = path.join(DATA_DIR, 'feishu-inbox.json');
const MAX_QUEUE_SIZE = 100;

/**
 * 生成消息 ID
 */
function generateMsgId() {
  const rand = Math.random().toString(36).substring(2, 6);
  return `msg_${Date.now()}_${rand}`;
}

export class MessageQueue {
  constructor() {
    this.inboxFile = INBOX_FILE;
  }

  /**
   * 确保数据文件存在
   */
  async ensureFile() {
    await fs.mkdir(DATA_DIR, { recursive: true });
    try {
      await fs.access(this.inboxFile);
    } catch {
      await fs.writeFile(this.inboxFile, JSON.stringify({ messages: [] }, null, 2), 'utf-8');
    }
  }

  /**
   * 加载队列数据
   */
  async load() {
    await this.ensureFile();
    try {
      const raw = await fs.readFile(this.inboxFile, 'utf-8');
      const data = JSON.parse(raw);
      if (!Array.isArray(data.messages)) {
        return { messages: [] };
      }
      return data;
    } catch {
      return { messages: [] };
    }
  }

  /**
   * 保存队列数据（带文件锁）
   */
  async saveWithLock(data) {
    await this.ensureFile();
    let release;
    try {
      release = await lockfile.lock(this.inboxFile, {
        retries: { retries: 5, minTimeout: 100 }
      });
      await fs.writeFile(this.inboxFile, JSON.stringify(data, null, 2), 'utf-8');
    } finally {
      if (release) await release();
    }
  }

  /**
   * 写入消息到队列
   *
   * @param {object} msg - 消息对象
   * @param {string} msg.feishu_message_id - 飞书消息 ID
   * @param {string} msg.sender_open_id - 发送者 open_id
   * @param {string} msg.text - 消息文本
   * @param {string} msg.timestamp - 时间戳
   */
  async pushMessage(msg) {
    await this.ensureFile();
    let release;
    try {
      release = await lockfile.lock(this.inboxFile, {
        retries: { retries: 5, minTimeout: 100 }
      });

      const raw = await fs.readFile(this.inboxFile, 'utf-8');
      let data;
      try {
        data = JSON.parse(raw);
        if (!Array.isArray(data.messages)) data = { messages: [] };
      } catch {
        data = { messages: [] };
      }

      const message = {
        id: generateMsgId(),
        feishu_message_id: msg.feishu_message_id,
        sender_open_id: msg.sender_open_id,
        text: msg.text,
        timestamp: msg.timestamp || new Date().toISOString()
      };

      data.messages.push(message);

      // 队列上限，丢弃最旧的
      if (data.messages.length > MAX_QUEUE_SIZE) {
        data.messages = data.messages.slice(-MAX_QUEUE_SIZE);
      }

      await fs.writeFile(this.inboxFile, JSON.stringify(data, null, 2), 'utf-8');
      console.error(`[消息队列] 写入消息: ${message.id}`);
      return message;
    } finally {
      if (release) await release();
    }
  }

  /**
   * 读取并清空所有待处理消息（原子操作）
   *
   * @returns {Array} 消息数组
   */
  async pollMessages() {
    await this.ensureFile();
    let release;
    try {
      release = await lockfile.lock(this.inboxFile, {
        retries: { retries: 5, minTimeout: 100 }
      });

      const raw = await fs.readFile(this.inboxFile, 'utf-8');
      let data;
      try {
        data = JSON.parse(raw);
        if (!Array.isArray(data.messages)) data = { messages: [] };
      } catch {
        data = { messages: [] };
      }

      const messages = data.messages;

      // 清空队列
      await fs.writeFile(this.inboxFile, JSON.stringify({ messages: [] }, null, 2), 'utf-8');

      if (messages.length > 0) {
        console.error(`[消息队列] 读取 ${messages.length} 条消息，队列已清空`);
      }
      return messages;
    } catch (error) {
      console.error('[消息队列] 轮询失败:', error.message);
      return [];
    } finally {
      if (release) await release();
    }
  }
}
