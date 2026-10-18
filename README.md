# 家庭健康记录（family-health）

记录家人身高、体重、BMI、视力等数据的轻量应用。全家人打开同一个网址，看到的是同一份数据。

## 代码放哪里、服务跑在哪里

这两件事是分开的，别搞混：

| | 位置 | 作用 |
| --- | --- | --- |
| **代码托管** | **GitHub**（仓库 `jssgsy/family-health`） | 只负责存放源码、记录改动历史 |
| **运行与部署** | **Cloudflare Workers + D1** | 真正跑起来的网站和数据库 |

**GitHub Pages 不参与本项目。** Pages 只能托管静态文件，没有后端，
数据只能存在每台设备自己的浏览器里 —— 那正是本项目要解决的问题。
所以本应用不能靠 Pages 运行，一定要部署到 Cloudflare。

## 当前部署信息

| 项目 | 值 |
| --- | --- |
| 访问地址 | https://family-health.fcsnwu.workers.dev |
| Worker 名称 | `family-health` |
| D1 数据库 | `family-health`（id 见 `wrangler.jsonc`） |
| 访问方式 | 已设置访问密码，首次打开会提示输入 |

把网址在手机上「添加到主屏幕」，就能像 App 一样全屏打开。

## 记录哪些数据

| 指标 | 说明 |
| --- | --- |
| 身高 | cm |
| 体重 | kg |
| BMI | 由同一条记录里的身高 + 体重自动算出；成年人会附带「偏瘦 / 正常 / 超重 / 肥胖」标注 |
| 视力 | 左眼、右眼分开记录，趋势图上画两条线 |
| 头围 | cm，适合小朋友 |
| 腰围 | cm |
| 体脂率 | % |
| 体温 | ℃ |
| 血压 / 心率 | 收缩压、舒张压、心率 |
| 备注 | 例如「体检」「早晨空腹」 |

一次记录只填当次测到的项目，其余留空即可。
每位成员可以设置名字、生日、性别、头像，界面会显示年龄。

**功能**：成员切换 · 最近数据概览（带与上次的变化量）· 趋势折线图（9 个指标可切换）·
历史记录列表（可编辑 / 删除）· CSV 导出与导入备份。

## 目录结构

```
.
├── public/                 # 前端静态页面
│   ├── index.html
│   └── app.js
├── worker/
│   └── index.js            # /api/* 后端逻辑
├── migrations/
│   └── 0001_init.sql       # 数据库表结构
├── wrangler.jsonc          # Cloudflare 配置
├── package.json
└── .dev.vars.example
```

> 注意：这就是本仓库的全部内容，命令都在**仓库根目录**执行。

## 日常使用

改完代码想发布，在仓库根目录执行：

```bash
npx wrangler deploy
```

数据库表结构有变动时（新增 `migrations/0002_xxx.sql` 之后）：

```bash
npx wrangler d1 migrations apply family-health --remote
```

## 可选：提交代码后自动部署

想做到「往 GitHub 一提交，Cloudflare 自动发布」，需要**在浏览器里做一次性授权**
（要安装 Cloudflare 的 GitHub App，这一步命令行代替不了）：

1. Cloudflare 控制台 → **Workers & Pages** → 选中 `family-health` → **Settings → Builds**
2. 连接 Git 账号，选中本仓库 `jssgsy/family-health`
3. 填写：
   - 分支：`main`
   - **Root directory / 根目录：留空**（就是仓库根目录）
   - Build command：`npm install`（或留空）
   - Deploy command：`npx wrangler deploy`
4. 保存后，往该分支推送就会自动发布

数据库的创建、建表、设置密码这几步仍然只在第一次做，之后不用重复。

## 改密码 / 取消密码

```bash
# 换一个新密码
npx wrangler secret put APP_PASSWORD

# 彻底取消密码（任何人都能打开网址）
npx wrangler secret delete APP_PASSWORD
```

密码只存在 Cloudflare 的加密存储里，**不在本仓库中**，请自己另外记好。

## 从零重建（换账号 / 换机器时）

```bash
npx wrangler login
npx wrangler d1 create family-health          # 把输出的 database_id 填进 wrangler.jsonc
npx wrangler d1 migrations apply family-health --remote
npx wrangler secret put APP_PASSWORD
npx wrangler deploy
```

## 本地开发（仅用于测试）

```bash
npm install                    # 需要时再装
npm run db:migrate:local       # 在本地建表
npm run dev                    # http://localhost:8787
```

本地跑会生成 `node_modules/`、`.wrangler/`、`.dev.vars` 这些文件，
它们**只是测试用的，随时可以整个删掉**，删掉不影响线上运行：

```bash
rm -rf node_modules .wrangler .dev.vars
```

这些文件也已经在 `.gitignore` 里，不会被提交到 GitHub。
本地数据库和线上数据库完全隔离，本地怎么折腾都不会影响真实数据。

## 数据备份

「设置 → 导出 CSV」会把全部成员和记录下载成一个 CSV 文件；
「导入 CSV」会**替换**云端全部数据，导入前建议先导出一份。

换 Cloudflare 账号、换网址迁移，也是靠这个 CSV 文件。

## 接口

除静态资源外，所有接口都在 `/api` 下。设置了 `APP_PASSWORD` 后，请求需要带上
`x-app-password` 请求头（前端会自动弹窗询问并记住）。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/state` | 读取全部成员与测量记录 |
| POST | `/api/members` | 新增成员 |
| PATCH | `/api/members/:id` | 修改成员 |
| DELETE | `/api/members/:id` | 删除成员（连同 TA 的全部记录） |
| POST | `/api/measurements` | 新增一次测量 |
| PATCH | `/api/measurements/:id` | 修改一次测量（字段传 `null` 表示清空） |
| DELETE | `/api/measurements/:id` | 删除一次测量 |
| POST | `/api/import` | 整体替换数据（CSV 导入使用） |

## 说明

- 删成员会**连带删除** TA 的所有测量记录，界面会提示，确认后再操作。
- 两次记录间隔任意，不需要每天记，想起来就记一次。
- 视力按小数记（如 `1.0`），用的是常见的小数记录法，不是 5 分制。
