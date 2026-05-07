const http = require('http');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'daily-work.sqlite');

const VALID_STATUSES = new Set(['backlog', 'todo', 'in_progress', 'review', 'done']);
const VALID_PRIORITIES = new Set(['high', 'medium', 'low']);

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);

const selectAllIssuesStatement = db.prepare(`
  SELECT id, issue_key, title, description, status, priority, assignee, due_date, tags_json, updated_at
  FROM issues
  ORDER BY updated_at DESC, issue_key DESC
`);

const selectIssueByIdStatement = db.prepare(`
  SELECT id, issue_key, title, description, status, priority, assignee, due_date, tags_json, updated_at
  FROM issues
  WHERE id = ?
`);

const insertIssueStatement = db.prepare(`
  INSERT INTO issues (
    id, issue_key, title, description, status, priority, assignee, due_date, tags_json, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const updateIssueStatement = db.prepare(`
  UPDATE issues
  SET issue_key = ?, title = ?, description = ?, status = ?, priority = ?, assignee = ?, due_date = ?, tags_json = ?, updated_at = ?
  WHERE id = ?
`);

const deleteIssueStatement = db.prepare('DELETE FROM issues WHERE id = ?');
const selectIssueKeysStatement = db.prepare('SELECT issue_key FROM issues');

function replaceAllIssues(issues) {
  db.exec('BEGIN');

  try {
    db.exec('DELETE FROM issues');
    for (const issue of issues) {
      insertIssueStatement.run(
        issue.id,
        issue.key,
        issue.title,
        issue.description,
        issue.status,
        issue.priority,
        issue.assignee,
        issue.dueDate,
        JSON.stringify(issue.tags),
        issue.updatedAt
      );
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

initializeDatabase();

function initializeDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS issues (
      id TEXT PRIMARY KEY,
      issue_key TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      priority TEXT NOT NULL,
      assignee TEXT NOT NULL,
      due_date TEXT NOT NULL DEFAULT '',
      tags_json TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL
    )
  `);

  const row = db.prepare('SELECT COUNT(*) AS count FROM issues').get();
  if (row.count > 0) {
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  const timestamp = new Date().toISOString();
  const seedIssues = [
    {
      id: randomUUID(),
      key: 'DW-101',
      title: 'Prepare morning plan',
      description: 'Break today into focused work blocks and identify the first task to finish.',
      status: 'todo',
      priority: 'high',
      assignee: 'You',
      dueDate: today,
      tags: ['planning', 'daily'],
      updatedAt: timestamp,
    },
    {
      id: randomUUID(),
      key: 'DW-102',
      title: 'Review open pull requests',
      description: 'Handle comments, unblock pending changes, and capture follow-up work.',
      status: 'in_progress',
      priority: 'medium',
      assignee: 'You',
      dueDate: today,
      tags: ['code-review'],
      updatedAt: timestamp,
    },
    {
      id: randomUUID(),
      key: 'DW-103',
      title: 'Document deployment checklist',
      description: 'Write the steps for release preparation, verification, and rollback.',
      status: 'review',
      priority: 'low',
      assignee: 'You',
      dueDate: '',
      tags: ['docs', 'ops'],
      updatedAt: timestamp,
    },
  ];

  replaceAllIssues(seedIssues);
}

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (requestUrl.pathname.startsWith('/api/')) {
      await handleApiRequest(req, res, requestUrl);
      return;
    }

    serveStaticFile(res, requestUrl.pathname);
  } catch (error) {
    console.error(error);
    if (error.statusCode) {
      sendJson(res, error.statusCode, { error: error.message });
      return;
    }

    if (error.code === 'ERR_SQLITE_ERROR' && error.message.includes('UNIQUE constraint failed')) {
      if (error.message.includes('issues.issue_key')) {
        sendJson(res, 409, { error: 'Issue key already exists' });
        return;
      }

      if (error.message.includes('issues.id')) {
        sendJson(res, 409, { error: 'Issue ID already exists' });
        return;
      }

      sendJson(res, 409, { error: 'Issue already exists' });
      return;
    }

    sendJson(res, 500, { error: 'Internal server error' });
  }
});

async function handleApiRequest(req, res, requestUrl) {
  if (req.method === 'OPTIONS') {
    sendCorsHeaders(res);
    res.writeHead(204);
    res.end();
    return;
  }

  const issueIdMatch = requestUrl.pathname.match(/^\/api\/issues\/([^/]+)$/);

  if (req.method === 'GET' && requestUrl.pathname === '/api/issues') {
    sendJson(res, 200, listIssues());
    return;
  }

  if (req.method === 'GET' && issueIdMatch) {
    const issueId = decodeURIComponent(issueIdMatch[1]);
    const issue = selectIssueByIdStatement.get(issueId);
    if (!issue) {
      sendJson(res, 404, { error: 'Issue not found' });
      return;
    }

    sendJson(res, 200, mapRowToIssue(issue));
    return;
  }

  if (req.method === 'POST' && requestUrl.pathname === '/api/issues') {
    const payload = validateIssue(readIssuePayload(await readJsonBody(req)));
    if (!payload.key) {
      payload.key = createIssueKey();
    }
    insertIssueStatement.run(
      payload.id,
      payload.key,
      payload.title,
      payload.description,
      payload.status,
      payload.priority,
      payload.assignee,
      payload.dueDate,
      JSON.stringify(payload.tags),
      payload.updatedAt
    );

    sendJson(res, 201, payload);
    return;
  }

  if (req.method === 'POST' && requestUrl.pathname === '/api/issues/replace') {
    const body = await readJsonBody(req);
    if (!Array.isArray(body)) {
      sendJson(res, 400, { error: 'Expected an array of issues' });
      return;
    }

    const normalizedIssues = body.map((issue) => validateIssue(readIssuePayload(issue)));
    replaceAllIssues(normalizedIssues);
    sendJson(res, 200, listIssues());
    return;
  }

  if (req.method === 'PUT' && issueIdMatch) {
    const issueId = decodeURIComponent(issueIdMatch[1]);
    const existing = selectIssueByIdStatement.get(issueId);
    if (!existing) {
      sendJson(res, 404, { error: 'Issue not found' });
      return;
    }

    const payload = validateIssue({ ...readIssuePayload(await readJsonBody(req)), id: issueId });
    payload.key = payload.key || existing.issue_key;
    updateIssueStatement.run(
      payload.key,
      payload.title,
      payload.description,
      payload.status,
      payload.priority,
      payload.assignee,
      payload.dueDate,
      JSON.stringify(payload.tags),
      payload.updatedAt,
      issueId
    );

    sendJson(res, 200, payload);
    return;
  }

  if (req.method === 'DELETE' && issueIdMatch) {
    const issueId = decodeURIComponent(issueIdMatch[1]);
    deleteIssueStatement.run(issueId);
    sendCorsHeaders(res);
    res.writeHead(204);
    res.end();
    return;
  }

  sendJson(res, 404, { error: 'Not found' });
}

function listIssues() {
  return selectAllIssuesStatement.all().map(mapRowToIssue);
}

function mapRowToIssue(row) {
  return {
    id: row.id,
    key: row.issue_key,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    assignee: row.assignee,
    dueDate: row.due_date,
    tags: parseTags(row.tags_json),
    updatedAt: row.updated_at,
  };
}

function parseTags(value) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    return [];
  }
}

function readIssuePayload(body) {
  return {
    id: typeof body.id === 'string' && body.id ? body.id : randomUUID(),
    key: typeof body.key === 'string' ? body.key : '',
    title: typeof body.title === 'string' ? body.title : '',
    description: typeof body.description === 'string' ? body.description : '',
    status: typeof body.status === 'string' ? body.status : 'backlog',
    priority: typeof body.priority === 'string' ? body.priority : 'medium',
    assignee: typeof body.assignee === 'string' && body.assignee.trim() ? body.assignee.trim() : 'Unassigned',
    dueDate: typeof body.dueDate === 'string' ? body.dueDate : '',
    tags: Array.isArray(body.tags) ? body.tags : [],
    updatedAt: typeof body.updatedAt === 'string' && body.updatedAt ? body.updatedAt : new Date().toISOString(),
  };
}

function validateIssue(issue) {
  const title = issue.title.trim();
  const key = issue.key.trim();

  if (!title) {
    sendValidationError('Title is required');
  }

  if (!VALID_STATUSES.has(issue.status)) {
    sendValidationError('Invalid status');
  }

  if (!VALID_PRIORITIES.has(issue.priority)) {
    sendValidationError('Invalid priority');
  }

  return {
    ...issue,
    title,
    key,
    description: issue.description.trim(),
    dueDate: issue.dueDate.trim(),
    tags: issue.tags
      .filter((tag) => typeof tag === 'string')
      .map((tag) => tag.trim())
      .filter(Boolean),
  };
}

function createIssueKey() {
  const rows = selectIssueKeysStatement.all();
  let maxNumber = 100;

  for (const row of rows) {
    const number = Number(String(row.issue_key).split('-')[1]) || 0;
    if (number > maxNumber) {
      maxNumber = number;
    }
  }

  return `DW-${maxNumber + 1}`;
}

function sendValidationError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  throw error;
}

function serveStaticFile(res, pathname) {
  const requestPath = pathname === '/' ? '/index.html' : pathname;
  const safePath = path.normalize(requestPath).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(PUBLIC_DIR, safePath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendPlainText(res, 403, 'Forbidden');
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const type = MIME_TYPES[ext] || 'application/octet-stream';

  fs.readFile(filePath, (error, data) => {
    if (error) {
      sendPlainText(res, error.code === 'ENOENT' ? 404 : 500, error.code === 'ENOENT' ? 'Not found' : 'Server error');
      return;
    }

    res.writeHead(200, { 'Content-Type': type });
    res.end(data);
  });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';

    req.on('data', (chunk) => {
      raw += chunk;
    });

    req.on('end', () => {
      if (!raw) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        const parseError = new Error('Invalid JSON');
        parseError.statusCode = 400;
        reject(parseError);
      }
    });

    req.on('error', reject);
  });
}

function sendJson(res, statusCode, payload) {
  sendCorsHeaders(res);
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function sendPlainText(res, statusCode, message) {
  res.writeHead(statusCode, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(message);
}

function sendCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

server.on('clientError', () => {});

server.listen(PORT, HOST, () => {
  console.log(`Mock Jira running at http://${HOST}:${PORT}`);
  console.log(`SQLite database: ${DB_PATH}`);
});
