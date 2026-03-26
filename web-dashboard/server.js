/**
 * Claude Task Hub - Web 仪表板后端
 *
 * ES Module 格式，端口 3456
 * 直接读写 mcp-server/data/tasks.json
 */

import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { setupWebSocketBridge } from './ws-bridge.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3456;

// 任务数据文件路径
const tasksFile = path.join(__dirname, '..', 'mcp-server', 'data', 'tasks.json');
const dataDir = path.dirname(tasksFile);

// 中间件
app.use(express.json());
app.use(express.static('public'));

// ==================== 工具函数 ====================

/**
 * 获取当前 ISO 时间戳
 */
function now() {
  return new Date().toISOString();
}

/**
 * 生成任务 ID
 * 格式: task_YYYYMMDD_HHmmss_XXXX
 */
function generateTaskId() {
  const date = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
  const rand = Math.random().toString(36).substring(2, 6);
  return `task_${date}_${rand}`;
}

/**
 * 确保数据目录和文件存在
 */
async function ensureDataFile() {
  try {
    await fs.mkdir(dataDir, { recursive: true });
    try {
      await fs.access(tasksFile);
    } catch {
      // 文件不存在，创建初始数据
      const initial = {
        metadata: {
          version: '1.0.0',
          created: now(),
          lastModified: now(),
          taskCount: 0,
          activeCount: 0
        },
        tasks: {}
      };
      await fs.writeFile(tasksFile, JSON.stringify(initial, null, 2), 'utf-8');
    }
  } catch (error) {
    console.error('初始化数据目录失败:', error);
  }
}

/**
 * 加载任务数据
 */
async function loadData() {
  await ensureDataFile();
  try {
    const raw = await fs.readFile(tasksFile, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return {
      metadata: { version: '1.0.0', created: now(), lastModified: now(), taskCount: 0, activeCount: 0 },
      tasks: {}
    };
  }
}

/**
 * 保存任务数据
 */
async function saveData(data) {
  await ensureDataFile();
  // 更新元数据
  const tasks = Object.values(data.tasks).filter(t => !t.is_deleted);
  data.metadata.lastModified = now();
  data.metadata.taskCount = tasks.length;
  data.metadata.activeCount = tasks.filter(t => t.status !== 'completed' && t.status !== 'cancelled').length;
  await fs.writeFile(tasksFile, JSON.stringify(data, null, 2), 'utf-8');
}

// ==================== API 路由 ====================

/**
 * GET /api/tasks - 列出任务（支持过滤）
 * 查询参数: status, priority, tag, q (搜索关键词)
 */
app.get('/api/tasks', async (req, res) => {
  try {
    const { status, priority, tag, q } = req.query;
    const data = await loadData();
    let tasks = Object.values(data.tasks).filter(t => !t.is_deleted);

    // 状态过滤
    if (status) {
      tasks = tasks.filter(t => t.status === status);
    }

    // 优先级过滤
    if (priority) {
      tasks = tasks.filter(t => t.priority === priority);
    }

    // 标签过滤
    if (tag) {
      tasks = tasks.filter(t => t.tags && t.tags.includes(tag));
    }

    // 搜索关键词过滤
    if (q) {
      const lowerQ = q.toLowerCase();
      tasks = tasks.filter(t =>
        t.title.toLowerCase().includes(lowerQ) ||
        (t.description && t.description.toLowerCase().includes(lowerQ)) ||
        (t.tags && t.tags.some(tg => tg.toLowerCase().includes(lowerQ)))
      );
    }

    // 按更新时间降序排列
    tasks.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));

    res.json({ success: true, data: tasks, count: tasks.length });
  } catch (error) {
    console.error('获取任务列表失败:', error);
    res.status(500).json({ success: false, error: '获取任务列表失败' });
  }
});

/**
 * GET /api/tasks/:id - 获取单个任务
 */
app.get('/api/tasks/:id', async (req, res) => {
  try {
    const data = await loadData();
    const task = data.tasks[req.params.id];
    if (!task || task.is_deleted) {
      return res.status(404).json({ success: false, error: '任务不存在' });
    }
    res.json({ success: true, data: task });
  } catch (error) {
    console.error('获取任务失败:', error);
    res.status(500).json({ success: false, error: '获取任务失败' });
  }
});

/**
 * POST /api/tasks - 创建任务
 * Body: { title, description, priority, tags, due_date }
 */
app.post('/api/tasks', async (req, res) => {
  try {
    const { title, description, priority, tags, due_date } = req.body;

    if (!title || !title.trim()) {
      return res.status(400).json({ success: false, error: '任务标题不能为空' });
    }

    const data = await loadData();
    const id = generateTaskId();
    const task = {
      id,
      title: title.trim(),
      description: description || '',
      status: 'pending',
      priority: priority || 'medium',
      tags: tags || [],
      source: 'web',
      assignee: null,
      created_at: now(),
      updated_at: now(),
      completed_at: null,
      due_date: due_date || null,
      notes: [],
      is_deleted: false,
      deleted_at: null
    };

    data.tasks[id] = task;
    await saveData(data);

    res.status(201).json({ success: true, data: task });
  } catch (error) {
    console.error('创建任务失败:', error);
    res.status(500).json({ success: false, error: '创建任务失败' });
  }
});

/**
 * PATCH /api/tasks/:id - 更新任务（部分字段）
 * Body: 任意可更新字段
 * 注意: 删除操作通过设置 is_deleted: true 实现（软删除）
 */
app.patch('/api/tasks/:id', async (req, res) => {
  try {
    const data = await loadData();
    const task = data.tasks[req.params.id];

    if (!task || task.is_deleted) {
      return res.status(404).json({ success: false, error: '任务不存在' });
    }

    const updates = req.body;

    // 记录状态变更
    if (updates.status && updates.status !== task.status) {
      if (!task.notes) task.notes = [];
      task.notes.push({
        content: `状态变更: ${task.status} -> ${updates.status}`,
        created_at: now(),
        source: 'web'
      });
      if (updates.status === 'completed') {
        task.completed_at = now();
      }
    }

    // 软删除处理
    if (updates.is_deleted === true) {
      task.is_deleted = true;
      task.deleted_at = now();
    }

    // 允许更新的字段
    const allowedFields = ['title', 'description', 'status', 'priority', 'tags', 'due_date', 'assignee'];
    for (const field of allowedFields) {
      if (updates[field] !== undefined) {
        task[field] = updates[field];
      }
    }

    task.updated_at = now();
    data.tasks[req.params.id] = task;
    await saveData(data);

    res.json({ success: true, data: task });
  } catch (error) {
    console.error('更新任务失败:', error);
    res.status(500).json({ success: false, error: '更新任务失败' });
  }
});

/**
 * GET /api/stats - 统计数据
 */
app.get('/api/stats', async (req, res) => {
  try {
    const data = await loadData();
    const tasks = Object.values(data.tasks).filter(t => !t.is_deleted);

    const today = new Date().toISOString().slice(0, 10);
    const todayTasks = tasks.filter(t => t.created_at && t.created_at.slice(0, 10) === today);

    const stats = {
      total: tasks.length,
      pending: tasks.filter(t => t.status === 'pending').length,
      in_progress: tasks.filter(t => t.status === 'in_progress').length,
      completed: tasks.filter(t => t.status === 'completed').length,
      cancelled: tasks.filter(t => t.status === 'cancelled').length,
      today_created: todayTasks.length,
      urgent: tasks.filter(t => t.priority === 'urgent' && t.status !== 'completed').length
    };

    res.json({ success: true, data: stats });
  } catch (error) {
    console.error('获取统计数据失败:', error);
    res.status(500).json({ success: false, error: '获取统计数据失败' });
  }
});

// ==================== 启动服务器 ====================

const httpServer = app.listen(PORT, () => {
  console.log('Web 仪表板已启动: http://localhost:3456');
});

// 挂载 WebSocket 桥接
setupWebSocketBridge(httpServer);
