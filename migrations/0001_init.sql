-- 家庭健康记录 · 初始表结构
-- 线上执行：npx wrangler d1 migrations apply family-health --remote

CREATE TABLE IF NOT EXISTS members (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  sex        TEXT NOT NULL DEFAULT '',      -- 'male' | 'female' | ''
  birthday   TEXT NOT NULL DEFAULT '',      -- YYYY-MM-DD
  emoji      TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS measurements (
  id          TEXT PRIMARY KEY,
  member_id   TEXT NOT NULL,
  date        TEXT NOT NULL,                -- YYYY-MM-DD
  time        TEXT NOT NULL,                -- HH:MM
  height      REAL,                         -- 身高 cm
  weight      REAL,                         -- 体重 kg
  vision_left REAL,                         -- 左眼视力
  vision_right REAL,                        -- 右眼视力
  head        REAL,                         -- 头围 cm
  waist       REAL,                         -- 腰围 cm
  body_fat    REAL,                         -- 体脂率 %
  temperature REAL,                         -- 体温 ℃
  systolic    INTEGER,                      -- 收缩压 mmHg
  diastolic   INTEGER,                      -- 舒张压 mmHg
  pulse       INTEGER,                      -- 心率 次/分
  note        TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_measurements_member ON measurements (member_id, date);
