/**
 * MiniMax Agent — 审查者
 * 环境变量: AGENT_MINIMAX_APP_ID / AGENT_MINIMAX_APP_SECRET / MINIMAX_API_KEY / MINIMAX_GROUP_ID
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { BaseAgent } from './base.js';
import { ROLES } from './roles.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '../.env') });

const role = ROLES.minimax;

async function callMinimax(messages) {
  const apiKey = process.env.MINIMAX_API_KEY;
  const groupId = process.env.MINIMAX_GROUP_ID;
  if (!apiKey) return '未配置 MINIMAX_API_KEY';
  if (!groupId) return '未配置 MINIMAX_GROUP_ID';

  const model = process.env.MINIMAX_MODEL || 'MiniMax-Text-01';

  // MiniMax 不支持 system role，把 system prompt 并入第一条 user 消息
  const normalized = messages.map((m, i) => {
    if (m.role === 'system') return { role: 'user', name: 'system', content: m.content };
    return { ...m, name: m.name || m.role };
  });

  const res = await fetch(`https://api.minimax.chat/v1/text/chatcompletion_v2?GroupId=${groupId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages: normalized, temperature: 0.3, max_tokens: 3000, stream: false }),
    signal: AbortSignal.timeout(60000)
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`HTTP ${res.status}: ${err.substring(0, 200)}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || '(无输出)';
}

const agent = new BaseAgent({
  name: role.name,
  role: role.role,
  systemPrompt: role.systemPrompt,
  appIdEnv: 'AGENT_MINIMAX_APP_ID',
  appSecretEnv: 'AGENT_MINIMAX_APP_SECRET',
  callAI: callMinimax
});

agent.start();
