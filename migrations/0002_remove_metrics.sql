-- 移除四个健康指标：头围、腰围、体脂率、体温（列和已有数据一起删除）
-- 线上执行：npx wrangler d1 migrations apply family-health --remote

ALTER TABLE measurements DROP COLUMN head;
ALTER TABLE measurements DROP COLUMN waist;
ALTER TABLE measurements DROP COLUMN body_fat;
ALTER TABLE measurements DROP COLUMN temperature;
