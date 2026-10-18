/**
 * 家庭健康记录 · 前端逻辑
 * 数据通过 /api/* 读写 Cloudflare D1 数据库。
 */
(() => {
  'use strict';

  const API_BASE = '/api';
  const PASSWORD_KEY = 'familyHealthPassword';

  /* ---------------------------------- 指标定义 ---------------------------------- */

  const FIELDS = [
    { key: 'height', label: '身高', unit: 'cm', step: '0.1', short: '身高' },
    { key: 'weight', label: '体重', unit: 'kg', step: '0.1', short: '体重' },
    { key: 'visionLeft', label: '左眼视力', unit: '', step: '0.1', short: '左眼' },
    { key: 'visionRight', label: '右眼视力', unit: '', step: '0.1', short: '右眼' },
    { key: 'head', label: '头围', unit: 'cm', step: '0.1', short: '头围' },
    { key: 'waist', label: '腰围', unit: 'cm', step: '0.1', short: '腰围' },
    { key: 'bodyFat', label: '体脂率', unit: '%', step: '0.1', short: '体脂率' },
    { key: 'temperature', label: '体温', unit: '℃', step: '0.1', short: '体温' },
    { key: 'systolic', label: '收缩压', unit: 'mmHg', step: '1', short: '收缩压' },
    { key: 'diastolic', label: '舒张压', unit: 'mmHg', step: '1', short: '舒张压' },
    { key: 'pulse', label: '心率', unit: '次/分', step: '1', short: '心率' },
  ];

  const METRICS = [
    { key: 'height', label: '身高', series: [{ field: 'height', name: '身高', color: '#2563eb' }] },
    { key: 'weight', label: '体重', series: [{ field: 'weight', name: '体重', color: '#0f766e' }] },
    { key: 'bmi', label: 'BMI', series: [{ field: 'bmi', name: 'BMI', color: '#b45309' }] },
    {
      key: 'vision',
      label: '视力',
      series: [
        { field: 'visionLeft', name: '左眼', color: '#2563eb' },
        { field: 'visionRight', name: '右眼', color: '#e11d48' },
      ],
    },
    { key: 'head', label: '头围', series: [{ field: 'head', name: '头围', color: '#7c3aed' }] },
    { key: 'waist', label: '腰围', series: [{ field: 'waist', name: '腰围', color: '#c2410c' }] },
    { key: 'bodyFat', label: '体脂率', series: [{ field: 'bodyFat', name: '体脂率', color: '#db2777' }] },
    { key: 'temperature', label: '体温', series: [{ field: 'temperature', name: '体温', color: '#dc2626' }] },
    {
      key: 'bp',
      label: '血压/心率',
      series: [
        { field: 'systolic', name: '收缩压', color: '#dc2626' },
        { field: 'diastolic', name: '舒张压', color: '#2563eb' },
        { field: 'pulse', name: '心率', color: '#0f766e' },
      ],
    },
  ];

  const EMOJI_CHOICES = ['🙂', '🧑', '👩', '👨', '👧', '👦', '👶', '🧒', '👴', '👵', '🐣', '🌟'];

  /* ---------------------------------- 工具 ---------------------------------- */

  const today = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const nowText = () =>
    new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
  const fmt = (v) => {
    const n = num(v);
    if (n === null || !Number.isFinite(n)) return '';
    return String(Math.round(n * 10) / 10);
  };
  const fmtSigned = (v) => {
    const n = Math.round(Number(v) * 10) / 10;
    return (n > 0 ? '+' : '') + n;
  };

  const $ = (id) => document.getElementById(id);
  const toast = (msg) => {
    const el = $('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => el.classList.remove('show'), 1900);
  };

  const computeBmi = (m) => {
    const h = num(m.height);
    const w = num(m.weight);
    if (!h || !w || h <= 0) return null;
    const bmi = w / Math.pow(h / 100, 2);
    return Math.round(bmi * 10) / 10;
  };

  const bmiCategory = (bmi) => {
    if (bmi === null) return '';
    if (bmi < 18.5) return '偏瘦';
    if (bmi < 24) return '正常';
    if (bmi < 28) return '超重';
    return '肥胖';
  };

  const ageText = (birthday) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(birthday || '')) return '';
    const b = new Date(birthday + 'T00:00:00');
    const now = new Date();
    let months = (now.getFullYear() - b.getFullYear()) * 12 + (now.getMonth() - b.getMonth());
    if (now.getDate() < b.getDate()) months -= 1;
    if (months < 0) return '';
    if (months < 24) return `${months} 个月`;
    return `${Math.floor(months / 12)} 岁`;
  };

  const ageInYears = (birthday) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(birthday || '')) return null;
    const b = new Date(birthday + 'T00:00:00');
    const now = new Date();
    let years = now.getFullYear() - b.getFullYear();
    const beforeBirthday = now.getMonth() < b.getMonth() || (now.getMonth() === b.getMonth() && now.getDate() < b.getDate());
    if (beforeBirthday) years -= 1;
    return years;
  };

  /* ------------------------------- 与后端通信 ------------------------------- */

  const getPassword = () => localStorage.getItem(PASSWORD_KEY) || '';
  const setPassword = (v) => {
    if (v) localStorage.setItem(PASSWORD_KEY, v);
    else localStorage.removeItem(PASSWORD_KEY);
  };

  async function api(path, { method = 'GET', body } = {}, allowRetry = true) {
    const headers = {};
    const password = getPassword();
    if (password) headers['x-app-password'] = password;
    if (body !== undefined) headers['content-type'] = 'application/json';

    const res = await fetch(API_BASE + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (res.status === 401 && allowRetry) {
      const input = prompt('请输入访问密码（在 Cloudflare 上设置的 APP_PASSWORD）');
      if (input) {
        setPassword(input.trim());
        return api(path, { method, body }, false);
      }
      throw new Error('需要访问密码');
    }

    const text = await res.text();
    let payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = null;
      }
    }
    if (!res.ok) throw new Error((payload && payload.error) || `请求失败（${res.status}）`);
    return payload;
  }

  const run = async (fn) => {
    try {
      await fn();
    } catch (err) {
      toast(err && err.message ? err.message : '操作失败，请重试');
    }
  };

  /* --------------------------------- 状态 --------------------------------- */

  let data = { members: [], measurements: [] };
  let activeMember = null;
  let activeMetric = 'height';
  let editingRecordId = null;
  let editingMemberId = null;
  let modalMode = null;

  // 支持 ?metric=vision 这样的链接，方便收藏某个指标的趋势图
  const urlMetric = new URLSearchParams(location.search).get('metric');
  if (urlMetric && METRICS.some((m) => m.key === urlMetric)) activeMetric = urlMetric;

  const memberName = (id) => data.members.find((m) => m.id === id)?.name || '已删除的成员';
  const memberById = (id) => data.members.find((m) => m.id === id);

  /** 某成员的全部记录，按时间正序（旧 → 新），并附带计算出的 BMI。 */
  const allRows = () =>
    data.measurements
      .map((m) => ({ ...m, bmi: computeBmi(m) }))
      .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time) || a.id.localeCompare(b.id));

  const rowsOf = (memberId) => allRows().filter((m) => m.memberId === memberId);
  const latestRow = (memberId) => {
    const rows = rowsOf(memberId);
    return rows.length ? rows[rows.length - 1] : null;
  };

  /** 返回某字段的最新值以及上一次的取值（用于计算变化量）。 */
  const fieldTrend = (memberId, field) => {
    const rows = rowsOf(memberId).filter((m) => num(m[field]) !== null);
    if (!rows.length) return { latest: null, prev: null };
    return { latest: rows[rows.length - 1], prev: rows.length > 1 ? rows[rows.length - 2] : null };
  };

  async function load() {
    const state = await api('/state');
    data = { members: state.members || [], measurements: state.measurements || [] };
    if (!data.members.some((m) => m.id === activeMember)) activeMember = data.members[0]?.id || null;
    render();
  }

  /* --------------------------------- 渲染 --------------------------------- */

  const renderMembers = () => {
    const box = $('members');
    if (!data.members.length) {
      box.innerHTML = '<div class="empty" style="flex:1">还没有家庭成员，点右下角 ＋ 或右上角「设置」添加</div>';
    } else {
      box.innerHTML = data.members
        .map((m) => {
          const last = latestRow(m.id);
          const sub = [ageText(m.birthday), last ? last.date : '暂无记录'].filter(Boolean).join(' · ');
          return `<button class="member ${m.id === activeMember ? 'active' : ''}" data-member="${esc(m.id)}"><span class="avatar">${esc(m.emoji || '🙂')}</span><span class="m-text"><span class="m-name">${esc(m.name)}</span><span class="m-sub">${esc(sub)}</span></span></button>`;
        })
        .join('');
      box.querySelectorAll('[data-member]').forEach((b) => {
        b.onclick = () => {
          activeMember = b.dataset.member;
          render();
        };
      });
    }
    $('memberHint').textContent = data.members.length ? '点击切换' : '';
  };

  const statCard = (label, valueHtml, deltaHtml, extraClass = '') => `<div class="stat ${extraClass}"><label>${label}</label><div class="value">${valueHtml}</div><div class="delta ${deltaHtml.cls}">${deltaHtml.text}</div></div>`;

  const renderOverview = () => {
    const m = memberById(activeMember);
    const box = $('overview');
    if (!m) {
      $('overviewTitle').textContent = '最近数据';
      $('overviewMeta').textContent = '';
      box.innerHTML = '<div class="empty" style="grid-column:1 / -1">请先添加家庭成员</div>';
      return;
    }
    $('overviewTitle').textContent = `${m.name} 最近数据`;
    const last = latestRow(m.id);
    $('overviewMeta').textContent = last ? `更新于 ${last.date} ${last.time}` : '暂无记录';

    if (!last) {
      box.innerHTML = '<div class="empty" style="grid-column:1 / -1">还没有记录，点右下角 ＋ 记录第一次数据</div>';
      return;
    }

    const delta = (field) => {
      const { latest, prev } = fieldTrend(m.id, field);
      if (!latest) return { cls: 'flat', text: '—' };
      if (!prev) return { cls: 'flat', text: '首次记录' };
      const diff = Math.round((num(latest[field]) - num(prev[field])) * 10) / 10;
      if (diff === 0) return { cls: 'flat', text: `与上次持平（${prev.date}）` };
      return { cls: diff > 0 ? 'up' : 'down', text: `${fmtSigned(diff)} vs ${prev.date}` };
    };

    const bmi = computeBmi(last);
    const years = ageInYears(m.birthday);
    const showBmiTag = bmi !== null && (years === null || years >= 18);
    const bmiValue = bmi === null ? '—' : `${bmi}${showBmiTag ? `<span class="bmi-tag">${bmiCategory(bmi)}</span>` : ''}`;

    const visionValue =
      num(last.visionLeft) === null && num(last.visionRight) === null
        ? '—'
        : `${fmt(last.visionLeft) || '—'} / ${fmt(last.visionRight) || '—'}`;

    const visionDelta = () => {
      const l = fieldTrend(m.id, 'visionLeft');
      const r = fieldTrend(m.id, 'visionRight');
      if (!l.latest && !r.latest) return { cls: 'flat', text: '—' };
      if (!l.prev && !r.prev) return { cls: 'flat', text: '首次记录' };
      return { cls: 'flat', text: '左眼 / 右眼' };
    };

    box.innerHTML = [
      statCard('身高', `${fmt(last.height) || '—'}<span>cm</span>`, delta('height')),
      statCard('体重', `${fmt(last.weight) || '—'}<span>kg</span>`, delta('weight')),
      statCard('BMI', bmiValue, delta('bmi')),
      statCard('视力（左/右）', visionValue, visionDelta()),
    ].join('');
  };

  const renderChartTabs = () => {
    $('chartTabs').innerHTML = METRICS.map(
      (mt) => `<button class="tab ${mt.key === activeMetric ? 'active' : ''}" data-metric="${mt.key}">${mt.label}</button>`
    ).join('');
    $('chartTabs')
      .querySelectorAll('[data-metric]')
      .forEach((b) => {
        b.onclick = () => {
          activeMetric = b.dataset.metric;
          renderChartTabs();
          renderChart();
        };
      });
  };

  const CHART_H = 230;

  const renderChart = () => {
    const canvas = $('chart');
    const empty = $('chartEmpty');
    const legend = $('chartLegend');
    const meta = METRICS.find((x) => x.key === activeMetric) || METRICS[0];
    const rows = activeMember ? rowsOf(activeMember) : [];

    const series = meta.series
      .map((s) => ({
        ...s,
        points: rows
          .map((row, index) => ({ index, value: num(row[s.field]), date: row.date }))
          .filter((p) => p.value !== null),
      }))
      .filter((s) => s.points.length);

    if (!series.length) {
      canvas.style.display = 'none';
      empty.hidden = false;
      legend.innerHTML = '';
      $('chartHint').textContent = '';
      return;
    }
    canvas.style.display = 'block';
    empty.hidden = true;

    $('chartHint').textContent = series.length > 1 ? `${series[0].points.length} 次记录` : `最近 ${series[0].points.length} 次记录`;
    legend.innerHTML =
      series.length > 1
        ? series.map((s) => `<span><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join('')
        : '';

    const wrapW = canvas.parentElement.clientWidth || 320;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    canvas.width = Math.max(1, Math.round(wrapW * dpr));
    canvas.height = Math.round(CHART_H * dpr);
    canvas.style.width = '100%';
    canvas.style.height = CHART_H + 'px';

    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, wrapW, CHART_H);

    const cssPalette = window.matchMedia('(prefers-color-scheme: dark)').matches
      ? { text: '#a1a8b5', grid: '#343945', surface: '#1b1e25' }
      : { text: '#727987', grid: '#e3e6eb', surface: '#ffffff' };
    const textColor = cssPalette.text;
    const gridColor = cssPalette.grid;

    const padL = 46;
    const padR = 16;
    const padT = 16;
    const padB = 28;
    const plotW = wrapW - padL - padR;
    const plotH = CHART_H - padT - padB;

    const allValues = series.flatMap((s) => s.points.map((p) => p.value));
    let min = Math.min(...allValues);
    let max = Math.max(...allValues);
    if (min === max) {
      min -= 1;
      max += 1;
    }
    const span = max - min;
    min -= span * 0.12;
    max += span * 0.12;

    const xCount = Math.max(rows.length - 1, 1);
    const xOf = (index) => padL + (rows.length <= 1 ? plotW / 2 : (index / xCount) * plotW);
    const yOf = (value) => padT + plotH - ((value - min) / (max - min)) * plotH;

    // 网格与 Y 轴刻度
    ctx.font = '11px -apple-system,sans-serif';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'right';
    ctx.lineWidth = 1;
    ctx.strokeStyle = gridColor;
    const ticks = 4;
    for (let i = 0; i <= ticks; i++) {
      const value = min + ((max - min) * i) / ticks;
      const y = yOf(value);
      ctx.globalAlpha = 0.5;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(wrapW - padR, y);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillStyle = textColor;
      ctx.fillText(fmt(value), padL - 8, y);
    }

    // X 轴日期
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = textColor;
    const labelIdx = rows.length <= 1 ? [0] : [0, Math.floor((rows.length - 1) / 2), rows.length - 1];
    [...new Set(labelIdx)].forEach((i) => {
      if (!rows[i]) return;
      const x = xOf(i);
      const label = rows[i].date.slice(5);
      ctx.fillText(label, Math.min(Math.max(x, padL + 14), wrapW - padR - 14), padT + plotH + 9);
    });

    // 折线
    series.forEach((s) => {
      ctx.strokeStyle = s.color;
      ctx.fillStyle = s.color;
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      s.points.forEach((p, i) => {
        const x = xOf(p.index);
        const y = yOf(p.value);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();

      s.points.forEach((p) => {
        const x = xOf(p.index);
        const y = yOf(p.value);
        ctx.beginPath();
        ctx.arc(x, y, 3.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = cssPalette.surface;
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.strokeStyle = s.color;
        ctx.lineWidth = 2;
      });

      // 最后一个点的数值
      const lastPoint = s.points[s.points.length - 1];
      if (lastPoint) {
        const x = xOf(lastPoint.index);
        const y = yOf(lastPoint.value);
        ctx.fillStyle = s.color;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.font = 'bold 11px -apple-system,sans-serif';
        const labelY = Math.max(padT + 10, y - 8);
        ctx.fillText(
          `${fmt(lastPoint.value)}`,
          Math.min(Math.max(x, padL + 14), wrapW - padR - 14),
          labelY
        );
        ctx.textAlign = 'left';
        ctx.font = '11px -apple-system,sans-serif';
      }
    });
  };

  const chipsFor = (m) => {
    const chips = [];
    const push = (label, value, unit) => chips.push(`<span class="chip">${label} <b>${value}</b>${unit || ''}</span>`);
    if (num(m.height) !== null) push('身高', fmt(m.height), 'cm');
    if (num(m.weight) !== null) push('体重', fmt(m.weight), 'kg');
    const bmi = computeBmi(m);
    if (bmi !== null) push('BMI', bmi, '');
    if (num(m.visionLeft) !== null || num(m.visionRight) !== null)
      push('视力', `${fmt(m.visionLeft) || '—'}/${fmt(m.visionRight) || '—'}`, '');
    if (num(m.head) !== null) push('头围', fmt(m.head), 'cm');
    if (num(m.waist) !== null) push('腰围', fmt(m.waist), 'cm');
    if (num(m.bodyFat) !== null) push('体脂率', fmt(m.bodyFat), '%');
    if (num(m.temperature) !== null) push('体温', fmt(m.temperature), '℃');
    if (num(m.systolic) !== null || num(m.diastolic) !== null)
      push('血压', `${fmt(m.systolic) || '—'}/${fmt(m.diastolic) || '—'}`, '');
    if (num(m.pulse) !== null) push('心率', fmt(m.pulse), '次/分');
    return chips.join('');
  };

  const renderLogs = () => {
    const rows = activeMember ? rowsOf(activeMember).slice().reverse() : [];
    $('logCount').textContent = rows.length ? `${rows.length} 条` : '';
    $('logs').innerHTML = rows.length
      ? rows
          .slice(0, 60)
          .map(
            (m) => `<div class="log"><div class="log-main"><div class="log-date">${esc(m.date)} <span class="log-time">${esc(m.time)}</span></div><div class="chips">${chipsFor(m)}</div>${m.note ? `<div class="log-note">${esc(m.note)}</div>` : ''}</div><div class="log-actions"><button class="icon-mini" data-edit="${esc(m.id)}">编辑</button><button class="icon-mini" data-del="${esc(m.id)}">删除</button></div></div>`
          )
          .join('')
      : '<div class="empty">还没有记录</div>';

    $('logs')
      .querySelectorAll('[data-edit]')
      .forEach((b) => {
        b.onclick = () => openMeasurementModal(b.dataset.edit);
      });
    $('logs')
      .querySelectorAll('[data-del]')
      .forEach((b) => {
        b.onclick = () =>
          run(async () => {
            const m = data.measurements.find((x) => x.id === b.dataset.del);
            if (!m) return;
            if (!confirm(`确定删除 ${m.date} ${m.time} 的这条记录吗？`)) return;
            await api('/measurements/' + encodeURIComponent(m.id), { method: 'DELETE' });
            await load();
            toast('已删除');
          });
      });
  };

  const render = () => {
    renderMembers();
    renderOverview();
    renderChartTabs();
    renderChart();
    renderLogs();
    $('todayLabel').textContent = new Date().toLocaleDateString('zh-CN', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      weekday: 'short',
    });
  };

  /* --------------------------------- 弹窗 --------------------------------- */

  const setModalActions = (html) => {
    $('modalActions').innerHTML = html;
  };
  const defaultActions = () =>
    setModalActions('<button id="cancelModal">取消</button><button class="primary" id="saveModal">保存</button>');

  const openModal = (mode, opts = {}) => {
    modalMode = mode;
    $('modalBackdrop').classList.add('show');

    if (mode === 'measurement') {
      defaultActions();
      openMeasurementModal(opts.id || null, true);
      return;
    }

    if (mode === 'member') {
      defaultActions();
      const m = opts.id ? memberById(opts.id) : null;
      editingMemberId = opts.id || null;
      $('modalTitle').textContent = m ? '编辑成员' : '添加成员';
      $('modalBody').innerHTML =
        '<p class="form-hint">生日和性别只用于显示年龄，可留空。</p>' +
        '<div class="field"><label>头像</label><div class="emoji-row" id="emojiRow">' +
        EMOJI_CHOICES.map(
          (e) => `<button type="button" data-emoji="${e}" class="${(m?.emoji || '🙂') === e ? 'active' : ''}">${e}</button>`
        ).join('') +
        '</div></div>' +
        `<div class="field"><label for="fName">名字（必填）</label><input id="fName" maxlength="24" placeholder="例如：爸爸" value="${esc(m?.name || '')}"></div>` +
        `<div class="field"><label for="fBirthday">生日</label><input id="fBirthday" type="date" value="${esc(m?.birthday || '')}"></div>` +
        `<div class="field"><label for="fSex">性别</label><select id="fSex"><option value="">不填写</option><option value="male"${m?.sex === 'male' ? ' selected' : ''}>男</option><option value="female"${m?.sex === 'female' ? ' selected' : ''}>女</option></select></div>`;
      $('modalBody')
        .querySelectorAll('[data-emoji]')
        .forEach((b) => {
          b.onclick = () => {
            $('modalBody').querySelectorAll('[data-emoji]').forEach((x) => x.classList.toggle('active', x === b));
          };
        });
      setTimeout(() => $('fName')?.focus(), 30);
      return;
    }

    if (mode === 'manageMembers') {
      setModalActions('<button id="cancelModal">关闭</button><button class="primary" id="addMemberBtn">＋ 添加成员</button>');
      $('modalTitle').textContent = '管理成员';
      $('modalBody').innerHTML =
        data.members
          .map((m) => {
            const count = data.measurements.filter((x) => x.memberId === m.id).length;
            const sub = [ageText(m.birthday), `${count} 条记录`].filter(Boolean).join(' · ');
            return `<div class="list-row"><div><div class="lr-name">${esc(m.emoji || '🙂')} ${esc(m.name)}</div><div class="lr-sub">${esc(sub)}</div></div><button class="secondary-btn" data-edit-member="${esc(m.id)}">编辑</button><button class="secondary-btn" data-del-member="${esc(m.id)}">删除</button></div>`;
          })
          .join('') || '<div class="empty">还没有成员</div>';
      setTimeout(() => {
        $('addMemberBtn').onclick = () => openModal('member');
        $('modalBody')
          .querySelectorAll('[data-edit-member]')
          .forEach((b) => {
            b.onclick = () => openModal('member', { id: b.dataset.editMember });
          });
        $('modalBody')
          .querySelectorAll('[data-del-member]')
          .forEach((b) => {
            b.onclick = () =>
              run(async () => {
                const m = memberById(b.dataset.delMember);
                if (!m) return;
                const count = data.measurements.filter((x) => x.memberId === m.id).length;
                if (!confirm(`删除「${m.name}」？\n\nTA 的 ${count} 条测量记录会一起删除，且无法恢复。`)) return;
                await api('/members/' + encodeURIComponent(m.id), { method: 'DELETE' });
                await load();
                openModal('manageMembers');
                toast('已删除');
              });
          });
      }, 0);
      return;
    }

    // settings
    setModalActions('<button id="cancelModal">关闭</button>');
    $('modalTitle').textContent = '设置';
    $('modalBody').innerHTML =
      '<p class="form-hint">数据保存在 Cloudflare D1 云端，任何设备打开同一网址看到的都是同一份数据。CSV 用于备份与迁移，导入会替换云端全部数据。</p>' +
      '<div class="field"><button class="secondary-btn" id="manageMembersBtn">👥 管理家庭成员</button></div>' +
      '<div class="field"><button class="secondary-btn" id="exportData">导出 CSV（备份）</button></div>' +
      '<div class="field"><button class="secondary-btn" id="importData">导入 CSV</button><input id="importFile" type="file" hidden></div>' +
      '<div class="field"><button class="secondary-btn" id="cloudPassword">🔐 云端访问密码</button></div>' +
      '<p class="form-hint" style="margin-top:14px">提示：把本页「添加到主屏幕」，就能像 App 一样打开。</p>';
    setTimeout(() => {
      $('manageMembersBtn').onclick = () => openModal('manageMembers');
      $('exportData').onclick = exportData;
      $('importData').onclick = () => $('importFile').click();
      $('importFile').onchange = importData;
      $('cloudPassword').onclick = () => {
        const current = getPassword();
        const value = prompt('设置访问密码（留空表示不使用密码）', current);
        if (value === null) return;
        setPassword(value.trim());
        toast(value.trim() ? '已保存访问密码' : '已清除访问密码');
      };
    }, 0);
  };

  const openMeasurementModal = (id, insideOpen) => {
    const m = id ? data.measurements.find((x) => x.id === id) : null;
    editingRecordId = m ? m.id : null;
    if (!insideOpen) {
      modalMode = 'measurement';
      defaultActions();
      $('modalBackdrop').classList.add('show');
    }
    $('modalTitle').textContent = m ? '编辑记录' : '记录一次数据';
    $('modalBody').innerHTML =
      '<p class="form-hint">填写这次测到的项目即可，留空的项会保持不记录。</p>' +
      `<div class="grid-2"><div class="field"><label for="fDate">日期</label><input id="fDate" type="date" value="${esc(m?.date || today())}"></div><div class="field"><label for="fTime">时间</label><input id="fTime" type="time" value="${esc(m?.time || nowText())}"></div></div>` +
      '<div class="grid-2">' +
      FIELDS.map(
        (f) =>
          `<div class="field"><label for="fld_${f.key}">${f.short}${f.unit ? `（${f.unit}）` : ''}</label><input id="fld_${f.key}" type="number" step="${f.step}" inputmode="decimal" placeholder="可选" value="${m && num(m[f.key]) !== null ? fmt(m[f.key]) : ''}"></div>`
      ).join('') +
      '</div>' +
      `<div class="field"><label for="fNote">备注</label><textarea id="fNote" maxlength="200" placeholder="例如：体检 / 早晨空腹">${esc(m?.note || '')}</textarea></div>`;

    setTimeout(() => {
      const first = $('fld_height');
      if (!m && first && window.innerWidth > 620) first.focus();
    }, 30);
  };

  const closeModal = () => {
    $('modalBackdrop').classList.remove('show');
    modalMode = null;
    editingRecordId = null;
    editingMemberId = null;
  };

  const saveModal = () =>
    run(async () => {
      if (modalMode === 'member') {
        const name = $('fName').value.trim();
        const birthday = $('fBirthday').value;
        const sex = $('fSex').value;
        const emoji = $('modalBody').querySelector('[data-emoji].active')?.dataset.emoji || '🙂';
        if (!name) {
          toast('请填写名字');
          $('fName')?.focus();
          return;
        }
        const body = { name, birthday, sex, emoji };
        if (editingMemberId) {
          await api('/members/' + encodeURIComponent(editingMemberId), { method: 'PATCH', body });
        } else {
          const created = await api('/members', { method: 'POST', body });
          activeMember = created.id;
        }
        await load();
        closeModal();
        toast('已保存');
        return;
      }

      if (modalMode === 'measurement') {
        const body = {
          memberId: activeMember,
          date: $('fDate').value,
          time: $('fTime').value || nowText(),
          note: $('fNote').value.trim(),
        };
        for (const f of FIELDS) {
          const raw = $(`fld_${f.key}`).value.trim();
          if (editingRecordId && raw === '') body[f.key] = null;
          else if (raw !== '') body[f.key] = Number(raw);
        }
        const anyValue = FIELDS.some((f) => body[f.key] !== undefined && body[f.key] !== null) || body.note;
        if (!anyValue) {
          toast('请至少填写一项数据');
          return;
        }
        if (!activeMember) {
          toast('请先添加家庭成员');
          return;
        }
        if (editingRecordId) {
          await api('/measurements/' + encodeURIComponent(editingRecordId), { method: 'PATCH', body });
        } else {
          await api('/measurements', { method: 'POST', body });
        }
        await load();
        closeModal();
        toast('已保存');
        return;
      }

      closeModal();
    });

  /* -------------------------------- 导出导入 -------------------------------- */

  const csvCell = (v) => {
    const s = String(v ?? '');
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };

  const exportData = () => {
    const headers = ['type', 'id', 'name', 'sex', 'birthday', 'emoji', 'memberId', 'date', 'time', ...FIELDS.map((f) => f.key), 'note'];
    const rows = [headers];
    data.members.forEach((m) => rows.push(['member', m.id, m.name, m.sex || '', m.birthday || '', m.emoji || '', '', '', '', ...FIELDS.map(() => ''), '']));
    allRows().forEach((m) =>
      rows.push(['measurement', m.id, '', '', '', '', m.memberId, m.date, m.time, ...FIELDS.map((f) => (num(m[f.key]) === null ? '' : m[f.key])), m.note || ''])
    );
    const csv = '\ufeff' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `家庭健康记录-${today()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast('已导出 CSV');
  };

  const parseCSV = (text) => {
    const rows = [];
    let row = [];
    let cell = '';
    let quoted = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quoted) {
        if (c === '"' && text[i + 1] === '"') {
          cell += '"';
          i++;
        } else if (c === '"') quoted = false;
        else cell += c;
      } else if (c === '"') quoted = true;
      else if (c === ',') {
        row.push(cell);
        cell = '';
      } else if (c === '\n') {
        row.push(cell.replace(/\r$/, ''));
        if (row.some((v) => v !== '')) rows.push(row);
        row = [];
        cell = '';
      } else cell += c;
    }
    row.push(cell.replace(/\r$/, ''));
    if (row.some((v) => v !== '')) rows.push(row);
    return rows;
  };

  const importData = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const rows = parseCSV((await file.text()).replace(/^\ufeff/, ''));
      if (rows.length < 2 || rows[0][0] !== 'type') throw new Error('CSV 表头不正确');
      const ix = Object.fromEntries(rows[0].map((h, i) => [h, i]));
      const val = (r, k) => r[ix[k]] ?? '';
      const parsed = { members: [], measurements: [] };
      const memberIds = new Set();
      for (const r of rows.slice(1)) {
        const type = val(r, 'type');
        if (type === 'member') {
          const id = val(r, 'id');
          const name = val(r, 'name');
          if (!id || !name) continue;
          memberIds.add(id);
          parsed.members.push({ id, name, sex: val(r, 'sex'), birthday: val(r, 'birthday'), emoji: val(r, 'emoji') || '🙂' });
        }
      }
      for (const r of rows.slice(1)) {
        if (val(r, 'type') !== 'measurement') continue;
        const memberId = val(r, 'memberId');
        if (!memberIds.has(memberId)) continue;
        const item = {
          id: val(r, 'id'),
          memberId,
          date: val(r, 'date'),
          time: val(r, 'time') || '00:00',
          note: val(r, 'note'),
        };
        FIELDS.forEach((f) => {
          const raw = val(r, f.key);
          if (raw !== '') item[f.key] = Number(raw);
        });
        parsed.measurements.push(item);
      }
      if (!parsed.members.length) throw new Error('CSV 里没有成员数据');

      if (!confirm(`将导入 ${parsed.members.length} 位成员、${parsed.measurements.length} 条测量记录，并替换云端现有数据。建议先备份。继续吗？`)) return;

      await api('/import', { method: 'POST', body: parsed });
      activeMember = null;
      await load();
      closeModal();
      toast('CSV 导入成功');
    } catch (err) {
      alert('导入失败：' + (err && err.message ? err.message : '请使用本应用导出的 CSV 文件'));
    } finally {
      e.target.value = '';
    }
  };

  /* -------------------------------- 事件绑定 -------------------------------- */

  const bindEvents = () => {
    $('addBtn').onclick = () => {
      if (!data.members.length) {
        toast('请先添加家庭成员');
        openModal('member');
        return;
      }
      openModal('measurement');
    };
    $('settingsBtn').onclick = () => openModal('settings');
    $('modalBackdrop').onclick = (e) => {
      if (e.target === $('modalBackdrop')) closeModal();
    };
    $('modalActions').onclick = (e) => {
      if (e.target.id === 'cancelModal') closeModal();
      else if (e.target.id === 'saveModal') saveModal();
    };
    window.addEventListener('resize', () => {
      if (modalMode === null) renderChart();
    });
  };

  /* --------------------------------- 启动 --------------------------------- */

  const boot = async () => {
    bindEvents();
    try {
      await load();
      if (!data.members.length) openModal('member');
    } catch (err) {
      toast(err && err.message ? err.message : '无法连接服务器');
      $('members').innerHTML = '<div class="empty" style="flex:1">无法连接云端，请检查网络或访问密码</div>';
    }
  };

  boot();
})();
