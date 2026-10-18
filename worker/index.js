/**
 * 家庭健康记录 · Cloudflare Worker 后端
 *
 * 静态前端资源放在 ./public，由 Cloudflare 静态资源（assets）托管；
 * 所有 /api/* 请求会先进入这里，读写 D1 数据库。
 *
 * 接口一览：
 *   GET    /api/state                  读取全部数据（members / measurements）
 *   POST   /api/members                新增成员
 *   PATCH  /api/members/:id            修改成员
 *   DELETE /api/members/:id            删除成员（同时删除其全部测量记录）
 *   POST   /api/measurements           新增一次测量
 *   PATCH  /api/measurements/:id       修改一次测量
 *   DELETE /api/measurements/:id       删除一次测量
 *   POST   /api/import                 整体替换数据
 *
 * 可选鉴权：设置环境变量（Worker secret）APP_PASSWORD 后，
 * 所有 /api/* 请求都需要携带 `x-app-password` 请求头。
 */

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

/** 允许记录的数值指标：区间用于拦截明显的手滑输入。 */
const NUMERIC_FIELDS = {
  height: { column: 'height', label: '身高', min: 20, max: 250, integer: false },
  weight: { column: 'weight', label: '体重', min: 0.5, max: 300, integer: false },
  visionLeft: { column: 'vision_left', label: '左眼视力', min: 0, max: 6, integer: false },
  visionRight: { column: 'vision_right', label: '右眼视力', min: 0, max: 6, integer: false },
  systolic: { column: 'systolic', label: '收缩压', min: 50, max: 300, integer: true },
  diastolic: { column: 'diastolic', label: '舒张压', min: 30, max: 200, integer: true },
  pulse: { column: 'pulse', label: '心率', min: 20, max: 250, integer: true },
};

const MEASUREMENT_COLUMNS = Object.values(NUMERIC_FIELDS).map((f) => f.column);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      try {
        return await handleApi(request, env, url);
      } catch (err) {
        const status = err && err.httpStatus ? err.httpStatus : 500;
        const message = err && err.message ? err.message : '服务器内部错误';
        if (status >= 500) console.error('API error:', err);
        return json({ error: message }, status);
      }
    }

    return env.ASSETS.fetch(request);
  },
};

/* ------------------------------------------------------------------ */
/* 路由                                                                */
/* ------------------------------------------------------------------ */

async function handleApi(request, env, url) {
  if (!isAuthorized(request, env)) throw httpError(401, '访问密码不正确');

  const method = request.method.toUpperCase();
  const [resource, id] = url.pathname.slice('/api'.length).split('/').filter(Boolean);

  if (!resource && method === 'GET') return getState(env);
  if (resource === 'state' && method === 'GET') return getState(env);
  if (resource === 'import' && method === 'POST') return importAll(request, env);

  if (resource === 'members') {
    if (!id && method === 'POST') return createMember(request, env);
    if (id && method === 'PATCH') return updateMember(request, env, id);
    if (id && method === 'DELETE') return deleteMember(env, id);
  }

  if (resource === 'measurements') {
    if (!id && method === 'POST') return createMeasurement(request, env);
    if (id && method === 'PATCH') return updateMeasurement(request, env, id);
    if (id && method === 'DELETE') return deleteMeasurement(env, id);
  }

  throw httpError(404, '接口不存在');
}

/* ------------------------------------------------------------------ */
/* 读取                                                                */
/* ------------------------------------------------------------------ */

async function getState(env) {
  const [members, measurements] = await env.DB.batch([
    env.DB.prepare('SELECT id, name, sex, birthday, emoji FROM members ORDER BY sort_order ASC, created_at ASC'),
    env.DB.prepare(
      `SELECT id, member_id, date, time, height, weight, vision_left, vision_right,
              systolic, diastolic, pulse, note
         FROM measurements
        ORDER BY date DESC, time DESC, id DESC`
    ),
  ]);

  return json({
    members: members.results || [],
    measurements: (measurements.results || []).map(toMeasurementApi),
  });
}

/* ------------------------------------------------------------------ */
/* 成员                                                                */
/* ------------------------------------------------------------------ */

async function createMember(request, env) {
  const body = await readJson(request);
  const name = cleanStr(body.name, 24);
  if (!name) throw httpError(400, '请填写成员名字');

  const member = {
    name,
    sex: normalizeSex(body.sex),
    birthday: normalizeBirthday(body.birthday),
    emoji: cleanStr(body.emoji, 8) || '🙂',
  };

  const dup = await env.DB.prepare('SELECT id FROM members WHERE lower(name) = lower(?)').bind(name).first();
  if (dup) throw httpError(409, '这个名字已存在，请换一个');

  const maxRow = await env.DB.prepare('SELECT COALESCE(MAX(sort_order), -1) AS max_order FROM members').first();
  const sortOrder = (maxRow && Number.isFinite(maxRow.max_order) ? maxRow.max_order : -1) + 1;

  const id = makeId('m');
  await env.DB.prepare(
    'INSERT INTO members (id, name, sex, birthday, emoji, sort_order) VALUES (?, ?, ?, ?, ?, ?)'
  )
    .bind(id, member.name, member.sex, member.birthday, member.emoji, sortOrder)
    .run();

  return json({ id, ...member }, 201);
}

async function updateMember(request, env, id) {
  const body = await readJson(request);
  const current = await env.DB.prepare('SELECT id, name, sex, birthday, emoji FROM members WHERE id = ?')
    .bind(id)
    .first();
  if (!current) throw httpError(404, '成员不存在');

  const name = body.name === undefined ? current.name : cleanStr(body.name, 24);
  const sex = body.sex === undefined ? current.sex : normalizeSex(body.sex);
  const birthday = body.birthday === undefined ? current.birthday : normalizeBirthday(body.birthday);
  const emoji = body.emoji === undefined ? current.emoji : cleanStr(body.emoji, 8) || '🙂';

  if (!name) throw httpError(400, '请填写成员名字');

  const dup = await env.DB.prepare('SELECT id FROM members WHERE lower(name) = lower(?) AND id <> ?')
    .bind(name, id)
    .first();
  if (dup) throw httpError(409, '这个名字已存在，请换一个');

  await env.DB.prepare('UPDATE members SET name = ?, sex = ?, birthday = ?, emoji = ? WHERE id = ?')
    .bind(name, sex, birthday, emoji, id)
    .run();

  return json({ id, name, sex, birthday, emoji });
}

async function deleteMember(env, id) {
  const current = await env.DB.prepare('SELECT id FROM members WHERE id = ?').bind(id).first();
  if (!current) throw httpError(404, '成员不存在');
  // 成员的测量记录一起删除，避免留下无归属的孤儿数据。
  const statements = [
    env.DB.prepare('DELETE FROM measurements WHERE member_id = ?').bind(id),
    env.DB.prepare('DELETE FROM members WHERE id = ?').bind(id),
  ];
  await env.DB.batch(statements);
  return json({ ok: true });
}

/* ------------------------------------------------------------------ */
/* 测量记录                                                            */
/* ------------------------------------------------------------------ */

async function createMeasurement(request, env) {
  const body = await readJson(request);
  const memberId = cleanStr(body.memberId, 64);
  if (!memberId) throw httpError(400, '缺少 memberId');

  const member = await env.DB.prepare('SELECT id FROM members WHERE id = ?').bind(memberId).first();
  if (!member) throw httpError(404, '成员不存在');

  const date = normalizeDate(body.date) || isoDate();
  const time = normalizeTime(body.time) || isoTime();
  const values = readNumericFields(body);
  const note = cleanStr(body.note, 200);

  if (!Object.keys(values).length && !note) throw httpError(400, '请至少填写一项数据');

  const id = makeId('r');
  const columns = ['id', 'member_id', 'date', 'time', 'note', ...Object.keys(values).map((k) => NUMERIC_FIELDS[k].column)];
  const params = [id, memberId, date, time, note, ...Object.values(values)];

  await env.DB.prepare(
    `INSERT INTO measurements (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`
  )
    .bind(...params)
    .run();

  return json({ id, memberId, date, time, note, ...values }, 201);
}

async function updateMeasurement(request, env, id) {
  const body = await readJson(request);
  const current = await env.DB.prepare('SELECT * FROM measurements WHERE id = ?').bind(id).first();
  if (!current) throw httpError(404, '记录不存在');

  const date = body.date === undefined ? current.date : normalizeDate(body.date) || current.date;
  const time = body.time === undefined ? current.time : normalizeTime(body.time) || current.time;
  const note = body.note === undefined ? current.note : cleanStr(body.note, 200);
  const values = readNumericFields(body);

  // 数值字段采用「传了就覆盖、传 null 清空」的语义
  const sets = ['date = ?', 'time = ?', 'note = ?'];
  const params = [date, time, note];

  for (const [key, spec] of Object.entries(NUMERIC_FIELDS)) {
    if (!(key in body)) continue;
    sets.push(`${spec.column} = ?`);
    if (values[key] === undefined) params.push(null);
    else params.push(values[key]);
  }

  await env.DB.prepare(`UPDATE measurements SET ${sets.join(', ')} WHERE id = ?`)
    .bind(...params, id)
    .run();

  const updated = await env.DB.prepare('SELECT * FROM measurements WHERE id = ?').bind(id).first();
  return json(toMeasurementApi(updated));
}

async function deleteMeasurement(env, id) {
  const result = await env.DB.prepare('DELETE FROM measurements WHERE id = ?').bind(id).run();
  if (!result.meta || result.meta.changes === 0) throw httpError(404, '记录不存在');
  return json({ ok: true });
}

/* ------------------------------------------------------------------ */
/* 整体导入                                                            */
/* ------------------------------------------------------------------ */

async function importAll(request, env) {
  const body = await readJson(request);
  const members = normalizeMembers(body.members);
  const measurements = normalizeMeasurements(body.measurements, new Set(members.map((m) => m.id)));

  if (!members.length) throw httpError(400, '至少需要一位成员');

  const statements = [
    env.DB.prepare('DELETE FROM measurements'),
    env.DB.prepare('DELETE FROM members'),
  ];

  members.forEach((m, index) => {
    statements.push(
      env.DB.prepare(
        'INSERT INTO members (id, name, sex, birthday, emoji, sort_order) VALUES (?, ?, ?, ?, ?, ?)'
      ).bind(m.id, m.name, m.sex, m.birthday, m.emoji, index)
    );
  });

  for (const r of measurements) {
    const columns = ['id', 'member_id', 'date', 'time', 'note', ...Object.keys(r.values).map((k) => NUMERIC_FIELDS[k].column)];
    const params = [r.id, r.memberId, r.date, r.time, r.note, ...Object.values(r.values)];
    statements.push(
      env.DB.prepare(
        `INSERT INTO measurements (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`
      ).bind(...params)
    );
  }

  await env.DB.batch(statements);

  return json({ ok: true, members: members.length, measurements: measurements.length });
}

function normalizeMembers(input) {
  if (!Array.isArray(input)) return [];
  return input
    .map((m, i) => ({
      id: cleanStr(m && m.id, 64) || `m${i + 1}`,
      name: cleanStr(m && m.name, 24),
      sex: normalizeSex(m && m.sex),
      birthday: normalizeBirthday(m && m.birthday),
      emoji: cleanStr(m && m.emoji, 8) || '🙂',
    }))
    .filter((m) => m.name);
}

function normalizeMeasurements(input, memberIds) {
  if (!Array.isArray(input)) return [];
  const out = [];
  input.forEach((raw, i) => {
    if (!raw) return;
    const memberId = cleanStr(raw.memberId, 64);
    const date = normalizeDate(raw.date);
    const time = normalizeTime(raw.time) || '00:00';
    if (!memberId || !memberIds.has(memberId) || !date) return;
    let values;
    try {
      values = readNumericFields(raw);
    } catch {
      values = {};
    }
    const note = cleanStr(raw.note, 200);
    if (!Object.keys(values).length && !note) return;
    out.push({ id: cleanStr(raw.id, 64) || `r${i + 1}`, memberId, date, time, note, values });
  });
  return out;
}

/* ------------------------------------------------------------------ */
/* 工具函数                                                            */
/* ------------------------------------------------------------------ */

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: JSON_HEADERS });
}

function httpError(status, message) {
  const err = new Error(message);
  err.httpStatus = status;
  return err;
}

async function readJson(request) {
  try {
    const body = await request.json();
    return body && typeof body === 'object' ? body : {};
  } catch {
    return {};
  }
}

function cleanStr(value, maxLength) {
  if (value === null || value === undefined) return '';
  return String(value).trim().slice(0, maxLength);
}

function readNumericFields(body) {
  const out = {};
  for (const [key, spec] of Object.entries(NUMERIC_FIELDS)) {
    const raw = body[key];
    if (raw === undefined || raw === null || raw === '') continue;
    const n = Number(raw);
    if (!Number.isFinite(n)) throw httpError(400, `${spec.label} 不是有效数字`);
    if (n < spec.min || n > spec.max) {
      throw httpError(400, `${spec.label} 应在 ${spec.min} ~ ${spec.max} 之间`);
    }
    out[key] = spec.integer ? Math.round(n) : Math.round(n * 10) / 10;
  }
  return out;
}

function toMeasurementApi(row) {
  if (!row) return null;
  const out = { id: row.id, memberId: row.member_id, date: row.date, time: row.time, note: row.note || '' };
  for (const [key, spec] of Object.entries(NUMERIC_FIELDS)) {
    out[key] = row[spec.column] === null || row[spec.column] === undefined ? null : row[spec.column];
  }
  return out;
}

function normalizeSex(value) {
  const v = cleanStr(value, 10).toLowerCase();
  return v === 'male' || v === 'female' ? v : '';
}

function normalizeBirthday(value) {
  const v = cleanStr(value, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : '';
}

function normalizeDate(value) {
  const v = cleanStr(value, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : '';
}

function normalizeTime(value) {
  const v = cleanStr(value, 5);
  return /^\d{2}:\d{2}$/.test(v) ? v : '';
}

function makeId(prefix) {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function isoDate() {
  return new Date().toISOString().slice(0, 10);
}

function isoTime() {
  return new Date().toISOString().slice(11, 16);
}

function isAuthorized(request, env) {
  const expected = env.APP_PASSWORD;
  if (!expected) return true;
  return (request.headers.get('x-app-password') || '') === expected;
}
