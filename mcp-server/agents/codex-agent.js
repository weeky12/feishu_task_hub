/**
 * Codex Agent — 执行者
 * 环境变量: AGENT_CODEX_APP_ID / AGENT_CODEX_APP_SECRET
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

const role = ROLES.codex;

/**
 * 调用 Codex CLI
 */
async function callCodex(messages) {
  const lastUser = [...messages].reverse().find(m => m.role === 'user');
  const prompt = lastUser?.content || '';

  return new Promise((resolve) => {
    execFile('C:/Users/Administrator/AppData/Roaming/npm/codex.cmd', [
      'exec', '--full-auto', '--skip-git-repo-check', '--ephemeral', prompt
    ], {
      timeout: 120000,
      maxBuffer: 2 * 1024 * 1024,
      shell: true
    }, (error, stdout) => {
      if (error) {
        resolve(error.killed ? '执行超时（2分钟限制）' : `执行失败: ${error.message.substring(0, 200)}`);
      } else {
        const out = stdout.trim() || '(无输出)';
        resolve(`执行结果:\n${out}`);
      }
    });
  });
}

const agent = new BaseAgent({
  name: role.name,
  role: role.role,
  systemPrompt: role.systemPrompt,
  appIdEnv: 'AGENT_CODEX_APP_ID',
  appSecretEnv: 'AGENT_CODEX_APP_SECRET',
  callAI: callCodex
});

agent.start();
