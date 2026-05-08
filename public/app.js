const LEGACY_STORAGE_KEY = 'daily-work-board-state-v1';
const MIGRATION_FLAG_KEY = 'daily-work-board-sqlite-migrated-v1';
const API_BASE_URL = resolveApiBaseUrl();

const STATUS_CONFIG = [
  { id: 'backlog', label: 'Backlog' },
  { id: 'todo', label: 'To Do' },
  { id: 'in_progress', label: 'In Progress' },
  { id: 'review', label: 'Review' },
  { id: 'done', label: 'Done' },
];

const state = {
  issues: [],
  selectedIssueId: null,
  filters: {
    search: '',
    assignee: 'all',
    priority: 'all',
    view: 'board',
  },
};

const elements = {
  boardView: document.querySelector('#boardView'),
  listView: document.querySelector('#listView'),
  issueTable: document.querySelector('#issueTable'),
  issueForm: document.querySelector('#issueForm'),
  issueId: document.querySelector('#issueId'),
  titleInput: document.querySelector('#titleInput'),
  descriptionInput: document.querySelector('#descriptionInput'),
  statusInput: document.querySelector('#statusInput'),
  priorityInput: document.querySelector('#priorityInput'),
  assigneeInput: document.querySelector('#assigneeInput'),
  dueDateInput: document.querySelector('#dueDateInput'),
  tagsInput: document.querySelector('#tagsInput'),
  searchInput: document.querySelector('#searchInput'),
  assigneeFilter: document.querySelector('#assigneeFilter'),
  priorityFilter: document.querySelector('#priorityFilter'),
  viewMode: document.querySelector('#viewMode'),
  newIssueButton: document.querySelector('#newIssueButton'),
  clearButton: document.querySelector('#clearButton'),
  deleteButton: document.querySelector('#deleteButton'),
  openCount: document.querySelector('#openCount'),
  activeCount: document.querySelector('#activeCount'),
  doneCount: document.querySelector('#doneCount'),
  todayList: document.querySelector('#todayList'),
  priorityList: document.querySelector('#priorityList'),
  formMessage: document.querySelector('#formMessage'),
};

initialize().catch((error) => {
  console.error('Failed to initialize app', error);
});

async function initialize() {
  populateStatusOptions();
  bindEvents();
  await migrateLegacyLocalData();
  await refreshIssues();
}

function populateStatusOptions() {
  elements.statusInput.innerHTML = STATUS_CONFIG.map(
    (status) => `<option value="${status.id}">${status.label}</option>`
  ).join('');
}

function bindEvents() {
  elements.issueForm.addEventListener('submit', handleSubmit);
  elements.newIssueButton.addEventListener('click', createNewIssueDraft);
  elements.clearButton.addEventListener('click', clearSelection);
  elements.deleteButton.addEventListener('click', deleteSelectedIssue);

  elements.searchInput.addEventListener('input', (event) => {
    state.filters.search = event.target.value.trim().toLowerCase();
    render();
  });

  elements.assigneeFilter.addEventListener('change', (event) => {
    state.filters.assignee = event.target.value;
    render();
  });

  elements.priorityFilter.addEventListener('change', (event) => {
    state.filters.priority = event.target.value;
    render();
  });

  elements.viewMode.addEventListener('change', (event) => {
    state.filters.view = event.target.value;
    render();
  });
}

async function migrateLegacyLocalData() {
  if (localStorage.getItem(MIGRATION_FLAG_KEY) === 'done') {
    return;
  }

  const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
  if (!raw) {
    localStorage.setItem(MIGRATION_FLAG_KEY, 'done');
    return;
  }

  try {
    const legacyIssues = JSON.parse(raw);
    if (Array.isArray(legacyIssues) && legacyIssues.length > 0) {
      await requestJson('/api/issues/replace', {
        method: 'POST',
        body: JSON.stringify(legacyIssues),
      });
    }

    localStorage.setItem(MIGRATION_FLAG_KEY, 'done');
    localStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch (error) {
    console.error('Failed to migrate legacy local data', error);
  }
}

async function refreshIssues() {
  state.issues = await requestJson('/api/issues');

  if (!state.selectedIssueId && state.issues[0]) {
    state.selectedIssueId = state.issues[0].id;
  }

  if (state.selectedIssueId && !state.issues.some((issue) => issue.id === state.selectedIssueId)) {
    state.selectedIssueId = state.issues[0] ? state.issues[0].id : null;
  }

  render();
}

async function handleSubmit(event) {
  event.preventDefault();

  try {
    clearMessage();

    const existingIssue = getSelectedIssue();
    const issueId = elements.issueId.value || generateId();

    const formIssue = {
      id: issueId,
      key: existingIssue ? existingIssue.key : '',
      title: elements.titleInput.value.trim(),
      description: elements.descriptionInput.value.trim(),
      status: elements.statusInput.value,
      priority: elements.priorityInput.value,
      assignee: elements.assigneeInput.value.trim() || 'Unassigned',
      dueDate: elements.dueDateInput.value,
      tags: elements.tagsInput.value
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean),
      updatedAt: new Date().toISOString(),
    };

    if (!formIssue.title) {
      showMessage('Title is required.', 'error');
      return;
    }

    const requestPath = existingIssue ? `/api/issues/${encodeURIComponent(existingIssue.id)}` : '/api/issues';
    const method = existingIssue ? 'PUT' : 'POST';

    await requestJson(requestPath, {
      method,
      body: JSON.stringify(formIssue),
    });

    state.selectedIssueId = issueId;
    await refreshIssues();
    showMessage(existingIssue ? 'Issue updated.' : 'Issue saved.', 'success');
  } catch (error) {
    console.error('Failed to save issue', error);
    showMessage(error.message || 'Failed to save issue.', 'error');
  }
}

function createNewIssueDraft() {
  state.selectedIssueId = '';
  elements.issueForm.reset();
  elements.issueId.value = '';
  elements.statusInput.value = 'backlog';
  elements.priorityInput.value = 'medium';
  elements.assigneeInput.value = 'You';
  clearMessage();
  elements.titleInput.focus();
  highlightActiveSelection();
}

function clearSelection() {
  state.selectedIssueId = null;
  elements.issueForm.reset();
  elements.issueId.value = '';
  elements.statusInput.value = 'backlog';
  elements.priorityInput.value = 'medium';
  elements.assigneeInput.value = 'You';
  clearMessage();
  highlightActiveSelection();
}

async function deleteSelectedIssue() {
  const selected = getSelectedIssue();
  if (!selected) {
    return;
  }

  try {
    clearMessage();
    await requestJson(`/api/issues/${encodeURIComponent(selected.id)}`, {
      method: 'DELETE',
    });

    state.selectedIssueId = null;
    await refreshIssues();
    showMessage('Issue deleted.', 'success');
  } catch (error) {
    console.error('Failed to delete issue', error);
    showMessage(error.message || 'Failed to delete issue.', 'error');
  }
}

function render() {
  renderFilters();
  renderBoard();
  renderList();
  renderSidebar();
  syncDetailPanel();
  toggleView();
}

function renderFilters() {
  const assignees = ['all', ...new Set(state.issues.map((issue) => issue.assignee).filter(Boolean))];
  elements.assigneeFilter.innerHTML = assignees
    .map((assignee) => {
      const label = assignee === 'all' ? 'All assignees' : assignee;
      return `<option value="${assignee}">${label}</option>`;
    })
    .join('');

  elements.assigneeFilter.value = assignees.includes(state.filters.assignee) ? state.filters.assignee : 'all';
  elements.priorityFilter.value = state.filters.priority;
  elements.viewMode.value = state.filters.view;
  elements.searchInput.value = state.filters.search;
}

function renderBoard() {
  const filteredIssues = getFilteredIssues();

  elements.boardView.innerHTML = STATUS_CONFIG.map((status) => {
    const columnIssues = filteredIssues.filter((issue) => issue.status === status.id);
    return `
      <section class="column" data-status="${status.id}">
        <header class="column-header">
          <strong>${status.label}</strong>
          <span>${columnIssues.length}</span>
        </header>
        <div class="column-body">
          ${columnIssues.map((issue) => renderIssueCard(issue)).join('')}
          ${columnIssues.length === 0 ? '<div class="empty-state">No issues</div>' : ''}
        </div>
      </section>
    `;
  }).join('');

  bindBoardInteractions();
}

function bindBoardInteractions() {
  elements.boardView.querySelectorAll('.issue-card').forEach((card) => {
    card.addEventListener('click', () => selectIssue(card.dataset.issueId));
    card.addEventListener('dragstart', (event) => {
      card.classList.add('dragging');
      event.dataTransfer?.setData('text/plain', card.dataset.issueId);
    });
    card.addEventListener('dragend', () => card.classList.remove('dragging'));
  });

  elements.boardView.querySelectorAll('.column').forEach((column) => {
    column.addEventListener('dragover', (event) => {
      event.preventDefault();
      column.classList.add('drag-over');
    });
    column.addEventListener('dragleave', () => column.classList.remove('drag-over'));
    column.addEventListener('drop', async (event) => {
      event.preventDefault();
      column.classList.remove('drag-over');
      const issueId = event.dataTransfer?.getData('text/plain');
      const status = column.dataset.status;
      await moveIssue(issueId, status);
    });
  });

  highlightActiveSelection();
}

function renderList() {
  const filteredIssues = getFilteredIssues();

  if (filteredIssues.length === 0) {
    elements.issueTable.innerHTML = '<div class="list-row"><span class="empty-state">No matching issues</span></div>';
    return;
  }

  elements.issueTable.innerHTML = filteredIssues
    .map(
      (issue) => `
        <div class="list-row" data-issue-id="${issue.id}">
          <span>${issue.key}</span>
          <strong>${escapeHtml(issue.title)}</strong>
          <span>${getStatusLabel(issue.status)}</span>
          <span>${capitalize(issue.priority)}</span>
          <span>${issue.dueDate || 'No date'}</span>
          <span>${escapeHtml(issue.assignee)}</span>
        </div>
      `
    )
    .join('');

  elements.issueTable.querySelectorAll('.list-row').forEach((row) => {
    row.addEventListener('click', () => selectIssue(row.dataset.issueId));
  });
}

function renderSidebar() {
  const openIssues = state.issues.filter((issue) => issue.status !== 'done');
  const activeIssues = state.issues.filter((issue) => ['todo', 'in_progress', 'review'].includes(issue.status));
  const startOfWeek = new Date();
  startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay());
  startOfWeek.setHours(0, 0, 0, 0);

  const completedThisWeek = state.issues.filter((issue) => {
    return issue.status === 'done' && new Date(issue.updatedAt) >= startOfWeek;
  });

  elements.openCount.textContent = String(openIssues.length);
  elements.activeCount.textContent = String(activeIssues.length);
  elements.doneCount.textContent = String(completedThisWeek.length);

  const today = new Date().toISOString().slice(0, 10);
  const todaysIssues = state.issues.filter((issue) => issue.dueDate === today).slice(0, 5);
  const highPriority = state.issues.filter((issue) => issue.priority === 'high' && issue.status !== 'done').slice(0, 5);

  renderCompactList(elements.todayList, todaysIssues, 'Nothing due today');
  renderCompactList(elements.priorityList, highPriority, 'No high-priority issues');
}

function renderCompactList(target, issues, emptyText) {
  if (issues.length === 0) {
    target.innerHTML = `<li><strong>${emptyText}</strong></li>`;
    return;
  }

  target.innerHTML = issues
    .map(
      (issue) => `
        <li data-issue-id="${issue.id}">
          <strong>${escapeHtml(issue.title)}</strong>
          <span>${issue.key} · ${getStatusLabel(issue.status)}</span>
        </li>
      `
    )
    .join('');

  target.querySelectorAll('li[data-issue-id]').forEach((item) => {
    item.addEventListener('click', () => selectIssue(item.dataset.issueId));
  });
}

function syncDetailPanel() {
  const selected = getSelectedIssue();

  if (!selected) {
    elements.issueForm.reset();
    elements.issueId.value = '';
    elements.statusInput.value = 'backlog';
    elements.priorityInput.value = 'medium';
    elements.assigneeInput.value = 'You';
    return;
  }

  elements.issueId.value = selected.id;
  elements.titleInput.value = selected.title;
  elements.descriptionInput.value = selected.description;
  elements.statusInput.value = selected.status;
  elements.priorityInput.value = selected.priority;
  elements.assigneeInput.value = selected.assignee;
  elements.dueDateInput.value = selected.dueDate;
  elements.tagsInput.value = selected.tags.join(', ');
}

function toggleView() {
  const isBoard = state.filters.view === 'board';
  elements.boardView.classList.toggle('hidden', !isBoard);
  elements.listView.classList.toggle('hidden', isBoard);
}

function selectIssue(issueId) {
  state.selectedIssueId = issueId;
  syncDetailPanel();
  highlightActiveSelection();
}

function highlightActiveSelection() {
  document.querySelectorAll('.issue-card').forEach((card) => {
    card.classList.toggle('active', card.dataset.issueId === state.selectedIssueId);
  });
}

async function moveIssue(issueId, status) {
  const issue = state.issues.find((item) => item.id === issueId);
  if (!issue || issue.status === status) {
    return;
  }

  const updatedIssue = {
    ...issue,
    status,
    updatedAt: new Date().toISOString(),
  };

  try {
    clearMessage();
    await requestJson(`/api/issues/${encodeURIComponent(issueId)}`, {
      method: 'PUT',
      body: JSON.stringify(updatedIssue),
    });

    state.selectedIssueId = issue.id;
    await refreshIssues();
  } catch (error) {
    console.error('Failed to move issue', error);
    showMessage(error.message || 'Failed to move issue.', 'error');
  }
}

function getFilteredIssues() {
  return state.issues.filter((issue) => {
    const matchesSearch =
      !state.filters.search ||
      [issue.title, issue.description, issue.tags.join(' ')]
        .join(' ')
        .toLowerCase()
        .includes(state.filters.search);

    const matchesAssignee = state.filters.assignee === 'all' || issue.assignee === state.filters.assignee;
    const matchesPriority = state.filters.priority === 'all' || issue.priority === state.filters.priority;

    return matchesSearch && matchesAssignee && matchesPriority;
  });
}

function getSelectedIssue() {
  return state.issues.find((issue) => issue.id === state.selectedIssueId) || null;
}

function renderIssueCard(issue) {
  const description = getIssueCardDescription(issue.description);
  const dueLabel = issue.dueDate ? formatDueDate(issue.dueDate) : 'No due date';
  const tagsMarkup = issue.tags.length
    ? `<div class="tag-row">${issue.tags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join('')}</div>`
    : '';

  return `
    <article class="issue-card" draggable="true" data-issue-id="${issue.id}">
      <div class="issue-card-top">
        <span class="issue-key">${issue.key}</span>
        <span class="priority-badge ${issue.priority}">${capitalize(issue.priority)}</span>
      </div>
      <h3 class="issue-title">${escapeHtml(issue.title)}</h3>
      <p class="issue-description">${escapeHtml(description)}</p>
      <div class="issue-footer">
        <div class="issue-meta">
          <span class="issue-meta-label">Assignee</span>
          <span class="issue-assignee">${escapeHtml(issue.assignee)}</span>
        </div>
        <div class="issue-meta issue-meta-right">
          <span class="issue-meta-label">Due</span>
          <span class="issue-due">${escapeHtml(dueLabel)}</span>
        </div>
      </div>
      ${tagsMarkup}
    </article>
  `;
}

function getStatusLabel(statusId) {
  return STATUS_CONFIG.find((status) => status.id === statusId)?.label || statusId;
}

function capitalize(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function truncate(value, maxLength) {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 1)}...`;
}

function getIssueCardDescription(description) {
  const normalized = (description || '').replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return 'No description';
  }

  return truncate(normalized, 140);
}

function formatDueDate(value) {
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
}

function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function showMessage(message, type) {
  elements.formMessage.textContent = message;
  elements.formMessage.classList.remove('hidden', 'error', 'success');
  elements.formMessage.classList.add(type);
}

function clearMessage() {
  elements.formMessage.textContent = '';
  elements.formMessage.classList.add('hidden');
  elements.formMessage.classList.remove('error', 'success');
}

function generateId() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }

  return `issue-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function requestJson(url, options = {}) {
  const headers = {
    ...(options.headers || {}),
  };

  if (options.body && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }

  const response = await fetch(`${API_BASE_URL}${url}`, {
    ...options,
    headers,
  });

  if (response.status === 204) {
    return null;
  }

  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    const text = await response.text();
    const responsePreview = text.trim().slice(0, 160);
    throw new Error(
      `Backend returned ${contentType || 'a non-JSON response'}${responsePreview ? `: ${responsePreview}` : ''}. Open the app at http://127.0.0.1:3000 and hard refresh.`
    );
  }

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || 'Request failed');
  }

  return payload;
}

function resolveApiBaseUrl() {
  if (window.location.protocol.startsWith('http') && window.location.port === '3000') {
    return '';
  }

  return 'http://127.0.0.1:3000';
}
