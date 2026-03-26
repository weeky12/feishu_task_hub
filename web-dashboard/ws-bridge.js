/**
 * WebSocket 桥接模块
 *
 * 挂载在 Express HTTP 服务器上，提供 /ws/bridge 端点
 * 接收飞书机器人转发的消息，写入文件消息队列供 MCP Server 轮询
 */

import { WebSocketServer } from 'ws';
import { URL } from 'url';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 动态导入 message-queue（跨目录引用）
const mqPath = path.join(__dirname, '..', 'mcp-server', 'message-queue.js');
const { MessageQueue } = await import(`file://${mqPath.replace(/\\/g, '/')}`);
const queue = new MessageQueue();

// 心跳检测间隔
const HEARTBEAT_INTERVAL = 30000;
const PONG_TIMEOUT = 10000;

/**
 * 在 HTTP 服务器上设置 WebSocket 桥接
 *
 * @param {import('http').Server} httpServer - Express HTTP 服务器实例
 */
export function setupWebSocketBridge(httpServer) {
  const wss = new WebSocketServer({ noServer: true });

  // 已注册的客户端 Map<role, ws>
  const clients = new Map();

  // HTTP upgrade 事件：仅处理 /ws/bridge 路径
  httpServer.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url, `http://${request.headers.host}`).pathname;

    if (pathname === '/ws/bridge') {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  // 连接处理
  wss.on('connection', (ws) => {
    let role = 'unknown';
    ws.isAlive = true;

    console.log('[WS Bridge] 新客户端连接');

    ws.on('pong', () => {
      ws.isAlive = true;
    });

    ws.on('message', async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        console.error('[WS Bridge] 无法解析消息，忽略');
        return;
      }

      // 注册身份
      if (msg.type === 'register' && msg.role) {
        role = msg.role;
        clients.set(role, ws);
        console.log(`[WS Bridge] 客户端注册: ${role}`);
        return;
      }

      // 飞书消息 → 写入队列
      if (msg.type === 'feishu_message' && msg.payload) {
        try {
          const result = await queue.pushMessage(msg.payload);
          console.log(`[WS Bridge] 飞书消息已入队: ${result.id}`);
          // 回复确认
          ws.send(JSON.stringify({ type: 'ack', message_id: result.id }));
        } catch (error) {
          console.error('[WS Bridge] 消息入队失败:', error.message);
          ws.send(JSON.stringify({ type: 'error', message: error.message }));
        }
        return;
      }

      console.log(`[WS Bridge] 未知消息类型: ${msg.type}`);
    });

    ws.on('close', () => {
      // 清理注册信息
      if (clients.get(role) === ws) {
        clients.delete(role);
      }
      console.log(`[WS Bridge] 客户端断开: ${role}`);
    });

    ws.on('error', (err) => {
      console.error(`[WS Bridge] 客户端错误 (${role}):`, err.message);
    });
  });

  // 心跳检测：每 30 秒 ping 一次
  const heartbeat = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (!ws.isAlive) {
        console.log('[WS Bridge] 客户端无响应，断开连接');
        ws.terminate();
        return;
      }
      ws.isAlive = false;
      ws.ping();
    });
  }, HEARTBEAT_INTERVAL);

  wss.on('close', () => {
    clearInterval(heartbeat);
  });

  console.log('[WS Bridge] WebSocket 桥已启动，路径: /ws/bridge');
}
