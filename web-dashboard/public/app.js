/**
 * Claude Task Hub - 前端应用逻辑
 *
 * 功能:
 *   - 获取统计和任务列表
 *   - 每 5 秒轮询刷新
 *   - 筛选切换（状态/优先级/搜索）
 *   - 创建任务（弹窗表单）
 *   - 更新任务状态（下拉菜单）
 *   - 相对时间显示
 */

// ==================== 全局状态 ====================

const state = {
  tasks: [],
  stats: {},
  filters: {
    status: '',
    priority: '',
    q: ''
  },
  pollTimer: null
};

// ==================== API 调用 ====================

const API = {
  /**
   * 获取任务列表
   */
  async getTasks(filters = {}) {
    const params = new URLSearchParams();
    if (filters.status) params.set('status', filters.status);
    if (filters.priority) params.set('priority', filters.priority);
    if (filters.q) params.set('q', filters.q);

    const res = await fetch(`/api/tasks?${params.toString()}`);
    const json = await res.json();
    return json.success ? json.data : [];
  },

  /**
   * 获取统计数据
   */
  async getStats() {
    const res = await fetch('/api/stats');
    const json = await res.json();
    return json.success ? json.data : {};
  },

  /**
   * 创建任务
   */
  async createTask(data) {
    const res = await fetch('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return await res.json();
  },

  /**
   * 更新任务
   */
  async updateTask(id, data) {
    const res = await fetch(`/api/tasks/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return await res.json();
  }
};

// ==================== 工具函数 ====================

/**
 * 将 ISO 时间转换为相对时间描述
 */
function relativeTime(isoStr) {
  if (!isoStr) return '';
  const now = Date.now();
  const target = new Date(isoStr).getTime();
  const diff = now - target;

  // 未来时间
  if (diff < 0) {
    const absDiff = Math.abs(diff);
    if (absDiff < 60000) return '即将';
    if (absDiff < 3600000) return `${Math.floor(absDiff / 60000)}分钟后`;
    if (absDiff < 86400000) return `${Math.floor(absDiff / 3600000)}小时后`;
    return `${Math.floor(absDiff / 86400000)}天后`;
  }

  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}小时前`;
  if (diff < 172800000) return '昨天';
  if (diff < 604800000) return `${Math.floor(diff / 86400000)}天前`;
  if (diff < 2592000000) return `${Math.floor(diff / 604800000)}周前`;
  return `${Math.floor(diff / 2592000000)}个月前`;
}

/**
 * 优先级中文映射
 */
const priorityLabel = {
  urgent: '紧急',
  high: '高',
  medium: '中',
  low: '低'
};

/**
 * 状态中文映射
 */
const statusLabel = {
  pending: '待处理',
  in_progress: '进行中',
  completed: '已完成',
  cancelled: '已取消'
};

/**
 * 来源中文映射
 */
const sourceLabel = {
  claude: 'Claude',
  web: 'Web',
  wechat: '微信',
  scheduled: '定时',
  api: 'API'
};

/**
 * 转义 HTML 特殊字符
 */
function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ==================== 渲染函数 ====================

/**
 * 渲染统计卡片
 */
function renderStats(stats) {
  document.getElementById('stat-pending').textContent = stats.pending || 0;
  document.getElementById('stat-in-progress').textContent = stats.in_progress || 0;
  document.getElementById('stat-completed').textContent = stats.completed || 0;
  document.getElementById('stat-today').textContent = stats.today_created || 0;

  // 更新筛选面板计数
  const total = (stats.pending || 0) + (stats.in_progress || 0) + (stats.completed || 0) + (stats.cancelled || 0);
  document.getElementById('count-all').textContent = total;
  document.getElementById('count-pending').textContent = stats.pending || 0;
  document.getElementById('count-in-progress').textContent = stats.in_progress || 0;
  document.getElementById('count-completed').textContent = stats.completed || 0;
  document.getElementById('count-cancelled').textContent = stats.cancelled || 0;
}

/**
 * 渲染单个任务卡片 HTML
 */
function renderTaskCard(task) {
  const tags = (task.tags || []).map(t => `<span class="tag">${escapeHtml(t)}</span>`).join('');
  const notes = (task.notes || []).map(n =>
    `<div class="note-item">${escapeHtml(n.content)} <span style="color:var(--text-muted);font-size:11px">${relativeTime(n.created_at)}</span></div>`
  ).join('');

  return `
    <div class="task-card" data-id="${task.id}" onclick="toggleTaskDetail('${task.id}')">
      <div class="task-card-main">
        <div class="task-card-body">
          <div class="task-title">
            ${escapeHtml(task.title)}
          </div>
          <div class="task-meta">
            <span class="priority-badge ${task.priority}">${priorityLabel[task.priority] || task.priority}</span>
            <span class="status-badge ${task.status}">${statusLabel[task.status] || task.status}</span>
            <span class="task-source">
              <i data-lucide="git-branch" style="width:12px;height:12px"></i>
              ${sourceLabel[task.source] || task.source || '未知'}
            </span>
            <span class="task-time">${relativeTime(task.updated_at)}</span>
          </div>
        </div>
      </div>
      <div class="task-detail" id="detail-${task.id}">
        ${task.description ? `<div class="task-description">${escapeHtml(task.description)}</div>` : ''}
        ${tags ? `<div class="task-tags">${tags}</div>` : ''}
        ${notes ? `<div class="task-notes"><h4>备注</h4>${notes}</div>` : ''}
        <div class="task-actions">
          <label>状态:</label>
          <select class="status-select" onchange="changeStatus('${task.id}', this.value)" onclick="event.stopPropagation()">
            <option value="pending" ${task.status === 'pending' ? 'selected' : ''}>待处理</option>
            <option value="in_progress" ${task.status === 'in_progress' ? 'selected' : ''}>进行中</option>
            <option value="completed" ${task.status === 'completed' ? 'selected' : ''}>已完成</option>
            <option value="cancelled" ${task.status === 'cancelled' ? 'selected' : ''}>已取消</option>
          </select>
          <button class="btn-delete" onclick="softDeleteTask('${task.id}'); event.stopPropagation();">
            <i data-lucide="trash-2" style="width:14px;height:14px"></i>
            删除
          </button>
        </div>
      </div>
    </div>
  `;
}

/**
 * 渲染任务列表
 */
function renderTaskList(tasks) {
  const container = document.getElementById('task-list');
  const badge = document.getElementById('task-count-badge');

  badge.textContent = `共 ${tasks.length} 项`;

  if (tasks.length === 0) {
    container.innerHTML = `
      <div class="task-list-empty">
        <i data-lucide="inbox"></i>
        <p>暂无任务</p>
      </div>
    `;
    lucide.createIcons();
    return;
  }

  container.innerHTML = tasks.map(renderTaskCard).join('');
  lucide.createIcons();
}

// ==================== 交互逻辑 ====================

/**
 * 切换任务详情展开/收起
 */
function toggleTaskDetail(taskId) {
  const card = document.querySelector(`.task-card[data-id="${taskId}"]`);
  if (card) {
    card.classList.toggle('expanded');
  }
}

/**
 * 更改任务状态
 */
async function changeStatus(taskId, newStatus) {
  try {
    await API.updateTask(taskId, { status: newStatus });
    await refreshAll();
  } catch (error) {
    console.error('更新状态失败:', error);
  }
}

/**
 * 软删除任务
 */
async function softDeleteTask(taskId) {
  if (!confirm('确定要删除此任务吗？')) return;
  try {
    await API.updateTask(taskId, { is_deleted: true });
    await refreshAll();
  } catch (error) {
    console.error('删除任务失败:', error);
  }
}

/**
 * 刷新所有数据
 */
async function refreshAll() {
  try {
    const [stats, tasks] = await Promise.all([
      API.getStats(),
      API.getTasks(state.filters)
    ]);
    state.stats = stats;
    state.tasks = tasks;
    renderStats(stats);
    renderTaskList(tasks);
  } catch (error) {
    console.error('刷新数据失败:', error);
  }
}

// ==================== 事件绑定 ====================

/**
 * 初始化筛选按钮
 */
function initFilters() {
  // 状态筛选
  document.querySelectorAll('[data-filter="status"]').forEach(btn => {
    btn.addEventListener('click', () => {
      // 更新激活状态
      document.querySelectorAll('[data-filter="status"]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.filters.status = btn.dataset.value;
      refreshAll();
    });
  });

  // 优先级筛选
  document.querySelectorAll('[data-filter="priority"]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-filter="priority"]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.filters.priority = btn.dataset.value;
      refreshAll();
    });
  });

  // 搜索输入（防抖）
  let searchTimer = null;
  document.getElementById('search-input').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.filters.q = e.target.value.trim();
      refreshAll();
    }, 300);
  });
}

/**
 * 初始化新建任务弹窗
 */
function initModal() {
  const overlay = document.getElementById('modal-overlay');
  const fabBtn = document.getElementById('fab-create');
  const cancelBtn = document.getElementById('modal-cancel');
  const form = document.getElementById('create-task-form');

  // 打开弹窗
  fabBtn.addEventListener('click', () => {
    overlay.classList.add('active');
    document.getElementById('task-title').focus();
  });

  // 关闭弹窗
  cancelBtn.addEventListener('click', () => {
    overlay.classList.remove('active');
    form.reset();
  });

  // 点击遮罩关闭
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      overlay.classList.remove('active');
      form.reset();
    }
  });

  // ESC 关闭
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && overlay.classList.contains('active')) {
      overlay.classList.remove('active');
      form.reset();
    }
  });

  // 提交表单
  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    const title = document.getElementById('task-title').value.trim();
    if (!title) return;

    const tagsRaw = document.getElementById('task-tags').value.trim();
    const tags = tagsRaw ? tagsRaw.split(',').map(t => t.trim()).filter(Boolean) : [];

    const data = {
      title,
      description: document.getElementById('task-desc').value.trim(),
      priority: document.getElementById('task-priority').value,
      tags,
      due_date: document.getElementById('task-due').value || null
    };

    try {
      const result = await API.createTask(data);
      if (result.success) {
        overlay.classList.remove('active');
        form.reset();
        await refreshAll();
      } else {
        alert('创建失败: ' + (result.error || '未知错误'));
      }
    } catch (error) {
      console.error('创建任务失败:', error);
      alert('创建任务失败，请检查网络连接');
    }
  });
}

// ==================== 启动 ====================

/**
 * 页面加载完成后初始化
 */
document.addEventListener('DOMContentLoaded', async () => {
  // 初始化 Lucide 图标
  lucide.createIcons();

  // 初始化交互
  initFilters();
  initModal();

  // 首次加载数据
  await refreshAll();

  // 每 5 秒轮询刷新
  state.pollTimer = setInterval(refreshAll, 5000);
});
