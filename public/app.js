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
    { key: 'waist', label: '腰围', unit: 'cm', step: '0.1', short: '腰围' },
    { key: 'visionLeft', label: '左眼视力', unit: '', step: '0.1', short: '左眼' },
    { key: 'visionRight', label: '右眼视力', unit: '', step: '0.1', short: '右眼' },
    { key: 'systolic', label: '收缩压', unit: 'mmHg', step: '1', short: '收缩压' },
    { key: 'diastolic', label: '舒张压', unit: 'mmHg', step: '1', short: '舒张压' },
    { key: 'pulse', label: '心率', unit: '次/分', step: '1', short: '心率' },
  ];

  const METRICS = [
    { key: 'height', label: '身高', series: [{ field: 'height', name: '身高', color: '#2563eb' }] },
    { key: 'weight', label: '体重', series: [{ field: 'weight', name: '体重', color: '#0f766e' }] },
    { key: 'waist', label: '腰围', series: [{ field: 'waist', name: '腰围', color: '#7c3aed' }] },
    { key: 'bmi', label: 'BMI', series: [{ field: 'bmi', name: 'BMI', color: '#b45309' }] },
    {
      key: 'vision',
      label: '视力',
      series: [
        { field: 'visionLeft', name: '左眼', color: '#2563eb' },
        { field: 'visionRight', name: '右眼', color: '#e11d48' },
      ],
    },
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

    let res;
    try {
      res = await fetch(API_BASE + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(20000),
      });
    } catch (err) {
      if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        throw new Error('网络超时，请检查网络后再试');
      }
      throw new Error('网络连接失败，请检查网络后再试');
    }

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
  let chartPoints = [];      // 当前图上的所有点（画布像素坐标），用于点击命中
  let chartGeom = null;      // 当前图的几何信息
  let chartSelection = null; // 当前选中的点：{ rowId, field }

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

  /** 从新到旧找第一条满足条件的记录：「最近数据」按指标各取自己最近的值。 */
  const latestRowWhere = (memberId, predicate) => {
    const rows = rowsOf(memberId);
    for (let i = rows.length - 1; i >= 0; i--) if (predicate(rows[i])) return rows[i];
    return null;
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

    // 每一项都取「该指标自己最近一次有值的记录」，避免最新那条没测的指标显示成 —
    const heightRow = latestRowWhere(m.id, (r) => num(r.height) !== null);
    const weightRow = latestRowWhere(m.id, (r) => num(r.weight) !== null);
    const bmiRow = latestRowWhere(m.id, (r) => computeBmi(r) !== null);
    const visionRow = latestRowWhere(m.id, (r) => num(r.visionLeft) !== null || num(r.visionRight) !== null);

    const bmi = bmiRow ? computeBmi(bmiRow) : null;
    const years = ageInYears(m.birthday);
    const showBmiTag = bmi !== null && (years === null || years >= 18);
    const bmiValue = bmi === null ? '—' : `${bmi}${showBmiTag ? `<span class="bmi-tag">${bmiCategory(bmi)}</span>` : ''}`;

    const visionValue = visionRow
      ? `${fmt(visionRow.visionLeft) || '—'} / ${fmt(visionRow.visionRight) || '—'}`
      : '—';

    const visionDelta = () => {
      const l = fieldTrend(m.id, 'visionLeft');
      const r = fieldTrend(m.id, 'visionRight');
      if (!l.latest && !r.latest) return { cls: 'flat', text: '—' };
      if (!l.prev && !r.prev) return { cls: 'flat', text: '首次记录' };
      // 视力值来自更早的记录时，明确标出日期，避免与上面的「更新于」混淆
      const from = visionRow && visionRow.id !== last.id ? ` · ${visionRow.date}` : '';
      return { cls: 'flat', text: `左眼 / 右眼${from}` };
    };

    box.innerHTML = [
      statCard('身高', `${heightRow ? fmt(heightRow.height) : '—'}<span>cm</span>`, delta('height')),
      statCard('体重', `${weightRow ? fmt(weightRow.weight) : '—'}<span>kg</span>`, delta('weight')),
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
      chartPoints = [];
      chartGeom = null;
      chartSelection = null;
      hideChartTip();
      return;
    }
    canvas.style.display = 'block';
    empty.hidden = true;
    hideChartTip();

    $('chartHint').textContent =
      (series.length > 1 ? `${series[0].points.length} 次记录` : `最近 ${series[0].points.length} 次记录`) + ' · 点击圆点看时间';
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

    // 记录几何信息与每个点的像素坐标，供点击命中使用
    chartGeom = { wrapW, padL, padR, padT, padB, plotW, plotH };
    chartPoints = [];

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
        const row = rows[p.index];
        const selected = row && chartSelection && chartSelection.rowId === row.id && chartSelection.field === s.field;
        ctx.beginPath();
        ctx.arc(x, y, 3.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = cssPalette.surface;
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.strokeStyle = s.color;
        ctx.lineWidth = 2;
        if (selected) {
          ctx.beginPath();
          ctx.arc(x, y, 7.5, 0, Math.PI * 2);
          ctx.stroke();
        }
        if (row) chartPoints.push({ x, y, row, field: s.field, color: s.color, value: p.value });
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

    // 选中的点若已不在当前图上（换指标 / 数据变化），取消选中
    if (chartSelection && !chartPoints.some((p) => p.row.id === chartSelection.rowId && p.field === chartSelection.field)) {
      chartSelection = null;
    }
  };

  /* --------------------------- 趋势图上的点交互 --------------------------- */

  const unitOf = (field) => {
    const f = FIELDS.find((x) => x.key === field);
    return f && f.unit ? f.unit : '';
  };

  const hideChartTip = () => {
    const tip = $('chartTip');
    if (tip) tip.hidden = true;
  };

  /** 把鼠标 / 手指坐标换算成画布坐标，返回最近的点（超过阈值算没点中）。 */
  const chartHit = (event) => {
    const canvas = $('chart');
    if (!canvas || !chartGeom || !chartPoints.length) return null;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const x = (event.clientX - rect.left) * (chartGeom.wrapW / rect.width);
    const y = (event.clientY - rect.top) * (CHART_H / rect.height);
    let best = null;
    let bestD = Infinity;
    chartPoints.forEach((pt) => {
      const d = Math.hypot(pt.x - x, pt.y - y);
      if (d < bestD) {
        bestD = d;
        best = pt;
      }
    });
    return best && bestD <= 26 ? best : null;
  };

  const showChartTip = (pt) => {
    const tip = $('chartTip');
    if (!tip || !chartGeom) return;
    const meta = METRICS.find((x) => x.key === activeMetric) || METRICS[0];
    const rowsHtml = meta.series
      .map((s) => ({ s, value: num(pt.row[s.field]) }))
      .filter((x) => x.value !== null)
      .map(
        ({ s, value }) =>
          `<div class="tip-row"><i style="background:${s.color}"></i>${esc(s.name)}<b>${fmt(value)}${esc(unitOf(s.field))}</b></div>`
      )
      .join('');
    tip.innerHTML = `<div class="tip-date">${esc(pt.row.date)}<span class="tip-time">${esc(pt.row.time)}</span></div>${rowsHtml}`;
    tip.hidden = false;
    const tipW = tip.offsetWidth;
    const tipH = tip.offsetHeight;
    const left = Math.min(Math.max(pt.x, tipW / 2 + 4), Math.max(chartGeom.wrapW - tipW / 2 - 4, tipW / 2 + 4));
    tip.style.left = left + 'px';
    tip.style.top = Math.max(pt.y - 12, tipH + 4) + 'px';
  };

  const selectedChartPoint = () =>
    chartSelection
      ? chartPoints.find((p) => p.row.id === chartSelection.rowId && p.field === chartSelection.field) || null
      : null;

  /** 点击圆点：选中并显示日期时间；点空白处则取消选中。 */
  const onChartClick = (event) => {
    const hit = chartHit(event);
    if (!hit) {
      if (chartSelection) {
        chartSelection = null;
        renderChart();
      }
      hideChartTip();
      return;
    }
    chartSelection = { rowId: hit.row.id, field: hit.field };
    renderChart();
    showChartTip(hit);
  };

  /** 鼠标悬停时预览提示，移开后回到已选中的点。 */
  const onChartMove = (event) => {
    const hit = chartHit(event);
    if (hit) {
      showChartTip(hit);
      return;
    }
    const selected = selectedChartPoint();
    if (selected) showChartTip(selected);
    else hideChartTip();
  };

  const chipsFor = (m) => {
    const chips = [];
    const push = (label, value, unit) => chips.push(`<span class="chip">${label} <b>${value}</b>${unit || ''}</span>`);
    if (num(m.height) !== null) push('身高', fmt(m.height), 'cm');
    if (num(m.weight) !== null) push('体重', fmt(m.weight), 'kg');
    if (num(m.waist) !== null) push('腰围', fmt(m.waist), 'cm');
    const bmi = computeBmi(m);
    if (bmi !== null) push('BMI', bmi, '');
    if (num(m.visionLeft) !== null || num(m.visionRight) !== null)
      push('视力', `${fmt(m.visionLeft) || '—'}/${fmt(m.visionRight) || '—'}`, '');
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

  /* ---------------- 记录表单：按使用频率排序 + 上次值一键沿用 ---------------- */

  // 表单顺序属于个人习惯，只存在本机浏览器里（不同设备各存各的），不写进云端数据库。
  const PREFS_KEY = 'familyHealth.fieldPrefs';
  const HALF_LIFE_DAYS = 60; // 使用次数的衰减半衰期：越久没用的项排得越靠后
  const RECENT_USE = 0.5;    // 衰减权重 ≥ 0.5（约两个月内用过）算作「最近常用」

  const loadPrefs = () => {
    try {
      const p = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
      return p && typeof p === 'object' ? p : {};
    } catch {
      return {};
    }
  };
  const savePrefs = (p) => localStorage.setItem(PREFS_KEY, JSON.stringify(p));

  /** 该成员手动调整过的指标顺序（没有则返回 null，表示用自动排序）。 */
  const manualOrderOf = (memberId) => {
    const list = loadPrefs().orders?.[memberId];
    return Array.isArray(list) && list.length ? list : null;
  };
  const setManualOrderOf = (memberId, keys) => {
    const p = loadPrefs();
    p.orders = p.orders || {};
    p.orders[memberId] = keys;
    savePrefs(p);
  };
  const clearManualOrderOf = (memberId) => {
    const p = loadPrefs();
    if (p.orders) delete p.orders[memberId];
    savePrefs(p);
  };

  /** 每个指标的使用情况：score 是按时间衰减的加权次数，count 是实际填写次数。 */
  const usageStats = (memberId) => {
    const stats = {};
    FIELDS.forEach((f) => {
      stats[f.key] = { score: 0, count: 0 };
    });
    const now = Date.now();
    for (const m of data.measurements) {
      if (m.memberId !== memberId) continue;
      const t = new Date(`${m.date}T00:00:00`).getTime();
      if (Number.isNaN(t)) continue;
      const weight = Math.pow(0.5, Math.max(0, now - t) / 86400000 / HALF_LIFE_DAYS);
      for (const f of FIELDS) {
        if (num(m[f.key]) === null) continue;
        stats[f.key].score += weight;
        stats[f.key].count += 1;
      }
    }
    return stats;
  };

  /** 表单里指标的显示顺序：自定义顺序优先，否则按使用频率从高到低。 */
  const rankedFieldKeys = (memberId, stats) => {
    const base = FIELDS.map((f, i) => ({ key: f.key, i, s: stats[f.key].score }));
    const manual = manualOrderOf(memberId);
    if (!manual) return base.sort((a, b) => b.s - a.s || a.i - b.i).map((x) => x.key);
    const byKey = new Map(base.map((x) => [x.key, x]));
    const picked = [];
    for (const key of manual) {
      const hit = byKey.get(key);
      if (hit) {
        picked.push(hit.key);
        byKey.delete(key);
      }
    }
    const rest = [...byKey.values()].sort((a, b) => b.s - a.s || a.i - b.i);
    return [...picked, ...rest.map((x) => x.key)];
  };

  /** 某个指标最近一次被记录的值，用于「上次 170」这种一键沿用。 */
  const lastValueOf = (memberId, key) => {
    const rows = rowsOf(memberId);
    for (let i = rows.length - 1; i >= 0; i--) {
      if (num(rows[i][key]) !== null) return { value: num(rows[i][key]), date: rows[i].date };
    }
    return null;
  };

  /** 每次保存固定用同一个 id：网络超时后重点保存，服务端会按这个 id 去重。 */
  const makeRequestId = () => 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 9);

  let mform = null; // 当前打开的记录表单的状态
  let saving = false; // 正在提交：期间禁止再次提交、关闭弹窗

  /** 提交中锁定底部按钮，避免连点 / 网络慢时重复提交。 */
  const setSaving = (on) => {
    const saveBtn = $('saveModal');
    if (saveBtn) {
      saveBtn.disabled = on;
      saveBtn.textContent = on ? '保存中…' : '保存';
    }
    const cancelBtn = $('cancelModal');
    if (cancelBtn) cancelBtn.disabled = on;
    $('modalBackdrop').classList.toggle('saving', on);
  };

  const fieldHtml = (key) => {
    const f = FIELDS.find((x) => x.key === key);
    const last = lastValueOf(mform.memberId, key);
    const prev = last
      ? `<button type="button" class="prev-btn" data-prev="${key}" title="上次记录于 ${esc(last.date)}">上次 ${esc(fmt(last.value))}</button>`
      : '';
    return `<div class="field">
      <div class="field-head"><label for="fld_${key}">${esc(f.short)}${f.unit ? `（${esc(f.unit)}）` : ''}</label>${prev}</div>
      <input id="fld_${key}" type="number" step="${f.step}" inputmode="decimal" placeholder="可选" value="${esc(mform.values[key] || '')}">
    </div>`;
  };

  const gridHtml = (keys) => `<div class="grid-2">${keys.map((k) => fieldHtml(k)).join('')}</div>`;

  const formHeadHtml = () =>
    `<div class="form-head">
      <span class="fh-title">记录项目</span>
      <span class="fh-hint">${mform.auto ? '按使用频率排序' : '自定义顺序'}</span>
      <button type="button" class="link-btn" id="orderBtn">调整顺序</button>
      ${mform.auto ? '' : '<button type="button" class="link-btn" id="autoBtn">恢复自动排序</button>'}
    </div>`;

  const reorderHtml = () => {
    const rows = mform.order
      .map((key, i) => {
        const f = FIELDS.find((x) => x.key === key);
        const st = mform.stats[key];
        const used = st.count ? `用过 ${st.count} 次` : '还没用过';
        return `<div class="order-row">
          <span class="or-name">${esc(f.short)}${f.unit ? `（${esc(f.unit)}）` : ''}</span>
          <span class="or-use">${used}</span>
          <button type="button" class="icon-mini" data-up="${i}" ${i === 0 ? 'disabled' : ''}>↑</button>
          <button type="button" class="icon-mini" data-down="${i}" ${i === mform.order.length - 1 ? 'disabled' : ''}>↓</button>
        </div>`;
      })
      .join('');
    return (
      '<p class="form-hint">上下挪动调整顺序，保存后这位成员的记录表单就按这个顺序显示。也可以随时点「恢复自动排序」。</p>' +
      `<div class="order-list">${rows}</div>`
    );
  };

  /** 渲染记录表单：常用项直接铺开，久未使用的项折叠在「其他项目」里。 */
  const renderMeasurementForm = () => {
    if (!mform) return;
    const body = $('modalBody');

    if (mform.reorder) {
      body.innerHTML = reorderHtml();
      body.querySelectorAll('[data-up]').forEach((b) => {
        b.onclick = () => moveField(Number(b.dataset.up), -1);
      });
      body.querySelectorAll('[data-down]').forEach((b) => {
        b.onclick = () => moveField(Number(b.dataset.down), 1);
      });
      return;
    }

    const keys = mform.order;
    let main = mform.auto ? keys.filter((k) => mform.stats[k].score >= RECENT_USE) : keys;
    let tail = mform.auto ? keys.filter((k) => mform.stats[k].score < RECENT_USE) : [];
    if (!main.length) {
      main = keys; // 还没有任何数据时全部显示，不做折叠
      tail = [];
    }

    const last = mform.editId ? null : latestRow(mform.memberId);
    const lastFilled = last ? FIELDS.filter((f) => num(last[f.key]) !== null).length : 0;

    body.innerHTML = [
      '<p class="form-hint">填写这次测到的项目即可，留空的项会保持不记录。</p>',
      `<div class="grid-2"><div class="field"><label for="fDate">日期</label><input id="fDate" type="date" value="${esc(mform.values.date || today())}"></div><div class="field"><label for="fTime">时间</label><input id="fTime" type="time" value="${esc(mform.values.time || nowText())}"></div></div>`,
      last
        ? `<div class="reuse-row"><span class="reuse-info">上次记录 ${esc(last.date)} ${esc(last.time)} · 填了 ${lastFilled} 项</span><button type="button" class="secondary-btn" id="reuseBtn">沿用上次</button></div>`
        : '',
      formHeadHtml(),
      gridHtml(main),
      tail.length
        ? `<button type="button" class="more-toggle" id="moreBtn">${mform.expanded ? '▾' : '▸'} 其他项目（${tail.length}）</button><div class="grid-2" id="moreBox" ${mform.expanded ? '' : 'hidden'}>${tail.map((k) => fieldHtml(k)).join('')}</div>`
        : '',
      `<div class="field"><label for="fNote">备注</label><textarea id="fNote" maxlength="200" placeholder="例如：体检 / 早晨空腹">${esc(mform.values.note || '')}</textarea></div>`,
    ].join('');

    // 记住输入的内容，重排 / 展开时不会丢失
    body.querySelectorAll('input,textarea').forEach((el) => {
      el.addEventListener('input', () => {
        if (!mform) return;
        if (el.id.startsWith('fld_')) mform.values[el.id.slice(4)] = el.value;
        else if (el.id === 'fNote') mform.values.note = el.value;
        else if (el.id === 'fDate') mform.values.date = el.value;
        else if (el.id === 'fTime') mform.values.time = el.value;
      });
    });

    body.querySelectorAll('[data-prev]').forEach((b) => {
      b.onclick = () => {
        const key = b.dataset.prev;
        const prev = lastValueOf(mform.memberId, key);
        const input = $('fld_' + key);
        if (!prev || !input) return;
        input.value = fmt(prev.value);
        mform.values[key] = input.value;
        input.focus();
        input.classList.add('flash');
        setTimeout(() => input.classList.remove('flash'), 700);
      };
    });

    const reuseBtn = $('reuseBtn');
    if (reuseBtn) {
      reuseBtn.onclick = () => {
        const row = latestRow(mform.memberId);
        if (!row) return;
        mform.expanded = true; // 先展开，保证填进去的值都看得见
        renderMeasurementForm();
        let n = 0;
        FIELDS.forEach((f) => {
          if (num(row[f.key]) === null) return;
          const el = $('fld_' + f.key);
          if (!el) return;
          el.value = fmt(row[f.key]);
          mform.values[f.key] = el.value;
          n++;
        });
        toast(n ? `已沿用 ${row.date} 的 ${n} 项数据` : '上次记录没有可沿用的数据');
      };
    }

    const moreBtn = $('moreBtn');
    if (moreBtn) moreBtn.onclick = () => {
      mform.expanded = !mform.expanded;
      renderMeasurementForm();
    };

    $('orderBtn').onclick = () => {
      mform.reorder = true;
      renderMeasurementForm();
      setModalActions('<button id="cancelModal">完成</button>');
    };

    const autoBtn = $('autoBtn');
    if (autoBtn) {
      autoBtn.onclick = () => {
        clearManualOrderOf(mform.memberId);
        mform.auto = true;
        mform.order = rankedFieldKeys(mform.memberId, mform.stats);
        renderMeasurementForm();
        toast('已恢复按使用频率排序');
      };
    }
  };

  /** 手动上下挪动一个指标；一动就切换成「自定义顺序」。 */
  const moveField = (index, delta) => {
    if (!mform) return;
    const to = index + delta;
    if (to < 0 || to >= mform.order.length) return;
    const order = mform.order.slice();
    const [item] = order.splice(index, 1);
    order.splice(to, 0, item);
    mform.order = order;
    mform.auto = false;
    setManualOrderOf(mform.memberId, order);
    renderMeasurementForm();
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

    const memberId = m ? m.memberId : activeMember;
    const stats = usageStats(memberId);
    const values = {};
    FIELDS.forEach((f) => {
      values[f.key] = m && num(m[f.key]) !== null ? fmt(m[f.key]) : '';
    });
    values.note = m?.note || '';
    values.date = m?.date || today();
    values.time = m?.time || nowText();

    mform = {
      memberId,
      editId: m?.id || null,
      requestId: m ? null : makeRequestId(),
      values,
      stats,
      auto: !manualOrderOf(memberId),
      order: rankedFieldKeys(memberId, stats),
      expanded: !!m, // 编辑时全部展开，方便核对
      reorder: false,
    };
    renderMeasurementForm();

    setTimeout(() => {
      if (!mform) return;
      const first = $('fld_' + (mform.order[0] || ''));
      if (!m && first && window.innerWidth > 620) first.focus();
    }, 30);
  };

  const closeModal = () => {
    $('modalBackdrop').classList.remove('show');
    modalMode = null;
    editingRecordId = null;
    editingMemberId = null;
    mform = null;
  };

  const saveModal = () =>
    run(async () => {
      if (saving) return; // 连点 / 双击：只处理第一次
      saving = true;
      setSaving(true);
      try {
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
          // 折叠起来的项目不在 DOM 里，所以统一从表单状态取值
          const DOM_IDS = { date: 'fDate', time: 'fTime', note: 'fNote' };
          const val = (key) => {
            const v = mform && mform.values ? mform.values[key] : undefined;
            if (v !== undefined && v !== null) return String(v).trim();
            const el = $(DOM_IDS[key] || `fld_${key}`);
            return el ? String(el.value).trim() : '';
          };
          const body = {
            memberId: (mform && mform.memberId) || activeMember,
            date: val('date') || today(),
            time: val('time') || nowText(),
            note: val('note'),
          };
          for (const f of FIELDS) {
            const raw = val(f.key);
            if (editingRecordId && raw === '') body[f.key] = null;
            else if (raw !== '') body[f.key] = Number(raw);
          }
          const anyValue = FIELDS.some((f) => body[f.key] !== undefined && body[f.key] !== null) || body.note;
          if (!anyValue) {
            toast('请至少填写一项数据');
            return;
          }
          if (!body.memberId) {
            toast('请先添加家庭成员');
            return;
          }
          if (editingRecordId) {
            await api('/measurements/' + encodeURIComponent(editingRecordId), { method: 'PATCH', body });
          } else {
            // 固定的 requestId：网络超时后再点保存，服务端会识别成同一次提交
            if (mform && mform.requestId) body.id = mform.requestId;
            await api('/measurements', { method: 'POST', body });
          }
          await load();
          closeModal();
          toast('已保存');
          return;
        }

        closeModal();
      } finally {
        saving = false;
        setSaving(false);
      }
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
    $('chart').onclick = onChartClick;
    $('chart').onmousemove = onChartMove;
    $('chart').onmouseleave = () => {
      const selected = selectedChartPoint();
      if (selected) showChartTip(selected);
      else hideChartTip();
    };
    $('modalBackdrop').onclick = (e) => {
      if (e.target === $('modalBackdrop') && !saving) closeModal();
    };
    $('modalActions').onclick = (e) => {
      if (e.target.id === 'cancelModal') {
        // 「调整顺序」模式下，底部按钮是「完成」，用来退回表单
        if (modalMode === 'measurement' && mform && mform.reorder) {
          mform.reorder = false;
          renderMeasurementForm();
          defaultActions();
          return;
        }
        closeModal();
      } else if (e.target.id === 'saveModal') saveModal();
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
