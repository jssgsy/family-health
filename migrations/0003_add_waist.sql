-- 加回「腰围」指标
-- 线上执行：npx wrangler d1 migrations apply family-health --remote

ALTER TABLE measurements ADD COLUMN waist REAL;  -- 腰围 cm
