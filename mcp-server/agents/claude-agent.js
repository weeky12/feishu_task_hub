/**
 * Claude Agent — 架构师
 * 环境变量: AGENT_CLAUDE_APP_ID / AGENT_CLAUDE_APP_SECRET
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process';
import { BaseAgent } from './base.js';
import { ROLES } from './roles.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '../.env') });

const role = ROLES.claude;

/**
 * 调用 Claude CLI
 * messages 仅取最后一条用户消息（CLI 模式不支持多轮）
 */
async function callClaude(messages) {
  const lastUser = [...messages].reverse().find(m => m.role === 'user');
  const prompt = lastUser?.content || '';

  return new Promise((resolve, reject) => {
    const claudePath = process.platform === 'win32'
      ? 'C:/Users/Administrator/AppData/Roaming/npm/claude.cmd'
      : 'claude';

    execFile(claudePath, ['-p', prompt], {
      timeout: 120000,
      maxBuffer: 2 * 1024 * 1024,
      shell: process.platform === 'win32',
      cwd: path.join(__dirname, '../..')
    }, (error, stdout) => {
      if (error) {
        resolve(error.killed ? '响应超时（2分钟限制）' : `调用失败: ${error.message.substring(0, 200)}`);
      } else {
        resolve((stdout || '').trim());
      }
    });
  });
}

const agent = new BaseAgent({
  name: role.name,
  role: role.role,
  systemPrompt: role.systemPrompt,
  appIdEnv: 'AGENT_CLAUDE_APP_ID',
  appSecretEnv: 'AGENT_CLAUDE_APP_SECRET',
  callAI: callClaude
});

agent.start();
