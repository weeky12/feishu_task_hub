/**
 * 飞书消息推送模块
 *
 * 使用 @larksuiteoapi/node-sdk 发送消息到飞书用户
 * 支持纯文本、任务卡片、统计信息等消息类型
 * 环境变量未配置时静默跳过，不影响 MCP Server 正常运行
 */

import * as lark from '@larksuiteoapi/node-sdk';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '.env') });

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
 * 操作对应的卡片颜色
 */
const ACTION_COLOR_MAP = {
  '创建': 'blue',
  '更新': 'orange',
  '完成': 'green',
  '紧急': 'red'
};

export class FeishuNotifier {
  constructor() {
    this.appId = process.env.FEISHU_APP_ID;
    this.appSecret = process.env.FEISHU_APP_SECRET;
    this.userOpenId = process.env.FEISHU_USER_OPEN_ID;
    this.enabled = false;

    // 检查环境变量是否完整
    if (!this.appId || !this.appSecret || !this.userOpenId) {
      console.error('[飞书通知] 环境变量未完整配置（需要 FEISHU_APP_ID, FEISHU_APP_SECRET, FEISHU_USER_OPEN_ID），通知功能已禁用');
      return;
    }

    // 初始化飞书客户端
    this.client = new lark.Client({
      appId: this.appId,
      appSecret: this.appSecret,
      disableTokenCache: false
    });
    this.enabled = true;
  }

  /**
   * 发送纯文本消息给用户
   *
   * @param {string} text - 消息文本内容
   */
  async sendText(text) {
    if (!this.enabled) {
      console.error('[飞书通知] 未启用，跳过发送文本消息');
      return;
    }

    try {
      await this.client.im.message.create({
        params: { receive_id_type: 'open_id' },
        data: {
          receive_id: this.userOpenId,
          msg_type: 'text',
          content: JSON.stringify({ text })
        }
      });
    } catch (error) {
      console.error('[飞书通知] 发送文本消息失败:', error.message);
    }
  }

  /**
   * 发送任务卡片消息
   *
   * @param {object} task - 任务对象
   * @param {string} action - 操作类型：'创建'|'更新'|'完成'|'紧急'
   */
  async sendTaskCard(task, action) {
    if (!this.enabled) {
      console.error('[飞书通知] 未启用，跳过发送任务卡片');
      return;
    }

    const headerColor = ACTION_COLOR_MAP[action] || 'blue';
    const priorityText = PRIORITY_MAP[task.priority] || task.priority;
    const statusText = STATUS_MAP[task.status] || task.status;

    // 构建交互式卡片内容
    const cardContent = {
      config: { wide_screen_mode: true },
      header: {
        template: headerColor,
        title: {
          tag: 'plain_text',
          content: `任务${action}: ${task.title}`
        }
      },
      elements: [
        {
          tag: 'div',
          fields: [
            {
              is_short: true,
              text: {
                tag: 'lark_md',
                content: `**优先级:** ${priorityText}`
              }
            },
            {
              is_short: true,
              text: {
                tag: 'lark_md',
                content: `**状态:** ${statusText}`
              }
            }
          ]
        },
        {
          tag: 'div',
          fields: [
            {
              is_short: true,
              text: {
                tag: 'lark_md',
                content: `**ID:** \`${task.id}\``
              }
            },
            {
              is_short: true,
              text: {
                tag: 'lark_md',
                content: `**来源:** ${task.source || 'claude'}`
              }
            }
          ]
        },
        {
          tag: 'div',
          fields: [
            {
              is_short: true,
              text: {
                tag: 'lark_md',
                content: `**创建时间:** ${formatTime(task.created_at)}`
              }
            },
            {
              is_short: true,
              text: {
                tag: 'lark_md',
                content: `**更新时间:** ${formatTime(task.updated_at)}`
              }
            }
          ]
        }
      ]
    };

    // 如果有描述，添加描述区块
    if (task.description) {
      cardContent.elements.push(
        { tag: 'hr' },
        {
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: `**描述:** ${task.description}`
          }
        }
      );
    }

    // 如果有标签，添加标签区块
    if (task.tags && task.tags.length > 0) {
      cardContent.elements.push({
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `**标签:** ${task.tags.map(t => `\`${t}\``).join(' ')}`
        }
      });
    }

    try {
      await this.client.im.message.create({
        params: { receive_id_type: 'open_id' },
        data: {
          receive_id: this.userOpenId,
          msg_type: 'interactive',
          content: JSON.stringify(cardContent)
        }
      });
    } catch (error) {
      console.error('[飞书通知] 发送任务卡片失败:', error.message);
    }
  }

  /**
   * 发送统计信息卡片
   *
   * @param {object} stats - 统计数据对象
   */
  async sendStats(stats) {
    if (!this.enabled) {
      console.error('[飞书通知] 未启用，跳过发送统计信息');
      return;
    }

    const cardContent = {
      config: { wide_screen_mode: true },
      header: {
        template: 'blue',
        title: {
          tag: 'plain_text',
          content: '任务统计概览'
        }
      },
      elements: [
        {
          tag: 'div',
          fields: [
            {
              is_short: true,
              text: {
                tag: 'lark_md',
                content: `**总任务数:** ${stats.total}`
              }
            },
            {
              is_short: true,
              text: {
                tag: 'lark_md',
                content: `**今日新建:** ${stats.today_created}`
              }
            }
          ]
        },
        {
          tag: 'div',
          fields: [
            {
              is_short: true,
              text: {
                tag: 'lark_md',
                content: `**待处理:** ${stats.pending}`
              }
            },
            {
              is_short: true,
              text: {
                tag: 'lark_md',
                content: `**进行中:** ${stats.in_progress}`
              }
            }
          ]
        },
        {
          tag: 'div',
          fields: [
            {
              is_short: true,
              text: {
                tag: 'lark_md',
                content: `**已完成:** ${stats.completed}`
              }
            },
            {
              is_short: true,
              text: {
                tag: 'lark_md',
                content: `**已取消:** ${stats.cancelled}`
              }
            }
          ]
        },
        { tag: 'hr' },
        {
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: stats.urgent > 0
              ? `**紧急任务:** ${stats.urgent} 个待处理`
              : '**紧急任务:** 无'
          }
        }
      ]
    };

    try {
      await this.client.im.message.create({
        params: { receive_id_type: 'open_id' },
        data: {
          receive_id: this.userOpenId,
          msg_type: 'interactive',
          content: JSON.stringify(cardContent)
        }
      });
    } catch (error) {
      console.error('[飞书通知] 发送统计信息失败:', error.message);
    }
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
