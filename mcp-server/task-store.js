/**
 * 任务数据存储层
 *
 * 提供任务的 CRUD 操作，使用 JSON 文件持久化
 * 支持文件锁避免多进程并发写冲突
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import lockfile from 'proper-lockfile';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.join(__dirname, 'data');
const TASKS_FILE = path.join(DATA_DIR, 'tasks.json');

/**
 * 生成任务 ID
 * 格式: task_YYYYMMDD_HHmmss_XXXX
 */
function generateTaskId() {
  const now = new Date();
  const date = now.toISOString().replace(/[-:T]/g, '').slice(0, 15);
  const rand = Math.random().toString(36).substring(2, 6);
  return `task_${date}_${rand}`;
}

/**
 * 获取当前 ISO 时间戳（带时区）
 */
function now() {
  return new Date().toISOString();
}

export class TaskStore {
  constructor() {
    this.dataFile = TASKS_FILE;
  }

  /**
   * 确保数据目录和文件存在
   */
  async ensureDataFile() {
    try {
      await fs.mkdir(DATA_DIR, { recursive: true });
      try {
        await fs.access(this.dataFile);
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
        await fs.writeFile(this.dataFile, JSON.stringify(initial, null, 2), 'utf-8');
      }
    } catch (error) {
      console.error('初始化数据目录失败:', error);
    }
  }

  /**
   * 加载任务数据
   */
  async load() {
    await this.ensureDataFile();
    try {
      const data = await fs.readFile(this.dataFile, 'utf-8');
      return JSON.parse(data);
    } catch {
      return {
        metadata: { version: '1.0.0', created: now(), lastModified: now(), taskCount: 0, activeCount: 0 },
        tasks: {}
      };
    }
  }

  /**
   * 保存任务数据（带文件锁）
   */
  async save(data) {
    await this.ensureDataFile();
    // 更新元数据
    const tasks = Object.values(data.tasks).filter(t => !t.is_deleted);
    data.metadata.lastModified = now();
    data.metadata.taskCount = tasks.length;
    data.metadata.activeCount = tasks.filter(t => t.status !== 'completed' && t.status !== 'cancelled').length;

    let release;
    try {
      release = await lockfile.lock(this.dataFile, { retries: { retries: 5, minTimeout: 100 } });
      await fs.writeFile(this.dataFile, JSON.stringify(data, null, 2), 'utf-8');
    } finally {
      if (release) await release();
    }
  }

  /**
   * 创建任务
   */
  async createTask({ title, description, priority, tags, due_date, source }) {
    const data = await this.load();
    const id = generateTaskId();
    const task = {
      id,
      title,
      description: description || '',
      status: 'pending',
      priority: priority || 'medium',
      tags: tags || [],
      source: source || 'claude',
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
    await this.save(data);
    return task;
  }

  /**
   * 更新任务
   */
  async updateTask(taskId, updates) {
    const data = await this.load();
    const task = data.tasks[taskId];
    if (!task || task.is_deleted) {
      throw new Error(`任务不存在: ${taskId}`);
    }

    // 记录状态变更
    if (updates.status && updates.status !== task.status) {
      task.notes.push({
        content: `状态变更: ${task.status} → ${updates.status}`,
        created_at: now(),
        source: 'system'
      });
      if (updates.status === 'completed') {
        task.completed_at = now();
      }
    }

    // 应用更新
    const allowedFields = ['title', 'description', 'status', 'priority', 'tags', 'due_date', 'assignee'];
    for (const field of allowedFields) {
      if (updates[field] !== undefined) {
        task[field] = updates[field];
      }
    }
    task.updated_at = now();
    data.tasks[taskId] = task;
    await this.save(data);
    return task;
  }

  /**
   * 获取单个任务
   */
  async getTask(taskId) {
    const data = await this.load();
    const task = data.tasks[taskId];
    if (!task || task.is_deleted) {
      return null;
    }
    return task;
  }

  /**
   * 列出任务
   */
  async listTasks({ status, priority, tag, limit } = {}) {
    const data = await this.load();
    let tasks = Object.values(data.tasks).filter(t => !t.is_deleted);

    if (status) {
      tasks = tasks.filter(t => t.status === status);
    }
    if (priority) {
      tasks = tasks.filter(t => t.priority === priority);
    }
    if (tag) {
      tasks = tasks.filter(t => t.tags.includes(tag));
    }

    // 按更新时间降序排列
    tasks.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));

    const maxLimit = limit || 20;
    return tasks.slice(0, maxLimit);
  }

  /**
   * 添加备注
   */
  async addNote(taskId, content, source = 'claude') {
    const data = await this.load();
    const task = data.tasks[taskId];
    if (!task || task.is_deleted) {
      throw new Error(`任务不存在: ${taskId}`);
    }

    task.notes.push({
      content,
      created_at: now(),
      source
    });
    task.updated_at = now();
    await this.save(data);
    return task;
  }

  /**
   * 搜索任务
   */
  async searchTasks(query, status) {
    const data = await this.load();
    const lowerQuery = query.toLowerCase();
    let tasks = Object.values(data.tasks).filter(t => !t.is_deleted);

    if (status) {
      tasks = tasks.filter(t => t.status === status);
    }

    tasks = tasks.filter(t => {
      return (
        t.title.toLowerCase().includes(lowerQuery) ||
        t.description.toLowerCase().includes(lowerQuery) ||
        t.tags.some(tag => tag.toLowerCase().includes(lowerQuery)) ||
        t.notes.some(n => n.content.toLowerCase().includes(lowerQuery))
      );
    });

    tasks.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
    return tasks;
  }

  /**
   * 软删除任务
   */
  async deleteTask(taskId) {
    const data = await this.load();
    const task = data.tasks[taskId];
    if (!task) {
      throw new Error(`任务不存在: ${taskId}`);
    }
    task.is_deleted = true;
    task.deleted_at = now();
    task.updated_at = now();
    await this.save(data);
    return task;
  }

  /**
   * 获取统计信息
   */
  async getStats() {
    const data = await this.load();
    const tasks = Object.values(data.tasks).filter(t => !t.is_deleted);

    const today = new Date().toISOString().slice(0, 10);
    const todayTasks = tasks.filter(t => t.created_at.slice(0, 10) === today);

    return {
      total: tasks.length,
      pending: tasks.filter(t => t.status === 'pending').length,
      in_progress: tasks.filter(t => t.status === 'in_progress').length,
      completed: tasks.filter(t => t.status === 'completed').length,
      cancelled: tasks.filter(t => t.status === 'cancelled').length,
      today_created: todayTasks.length,
      urgent: tasks.filter(t => t.priority === 'urgent' && t.status !== 'completed').length
    };
  }
}
