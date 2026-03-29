/**
 * Kimi Agent — 实现者
 * 环境变量: AGENT_KIMI_APP_ID / AGENT_KIMI_APP_SECRET / KIMI_API_KEY
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { BaseAgent } from './base.js';
import { ROLES } from './roles.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '../.env') });

const role = ROLES.kimi;

async function callKimi(messages) {
  const apiKey = process.env.KIMI_API_KEY;
  if (!apiKey) return '未配置 KIMI_API_KEY';

  const model = process.env.KIMI_MODEL || 'moonshot-v1-32k';

  const res = await fetch('https://api.moonshot.cn/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages, temperature: 0.3, max_tokens: 3000 }),
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
  appIdEnv: 'AGENT_KIMI_APP_ID',
  appSecretEnv: 'AGENT_KIMI_APP_SECRET',
  callAI: callKimi
});

agent.start();
