# eSIM 保号提醒服务

一个轻量、自托管的 eSIM 保号提醒网页应用，支持自动识别手机号码归属国家，并在到期前 **30 天（一个月）、15 天、7 天、3 天** 通过 **Telegram Bot** 自动发送提醒。

## 功能特点

- **网页管理**：添加、编辑、删除、搜索与筛选 eSIM 卡片，实时显示到期日期与剩余天数。
- **号码国家自动识别**：输入带国际区号的号码（如 `+44`、`+852`、`+1`、`+81`、`+65` 等），自动识别国家/地区、国旗图标及格式化号码。
- **多阶段 Telegram 提醒**：在距离到期 **30 天、15 天、7 天、3 天** 时自动推送 Telegram 消息，同一周期内自动去重，不重复刷屏。
- **一键已保号/续期**：完成保号操作后点击「已保号 (重置周期)」，即可重置本周期并开启新一轮提醒。
- **网页端配置与测试**：支持在网页直接填写 Telegram Bot Token 和 Chat ID，支持一键发送测试消息及查看历史提醒记录。
- **零外部数据库依赖**：使用 Node.js 24 内置 `node:sqlite` 持久化存储。

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 启动服务

```bash
npm start
```

服务默认运行在 `http://localhost:3000`。

### 3. 配置 Telegram Bot

1. 在 Telegram 中搜索 `@BotFather`，发送 `/newbot` 创建一个机器人并获取 **Bot Token**。
2. 搜索 `@userinfobot` 获取你的 **Chat ID**，并向你刚创建的 Bot 发送一条 `/start` 消息。
3. 打开网页右上角 **「⚙️ Telegram 设置」**，填入 Bot Token 和 Chat ID，点击 **「发送测试消息」** 验证成功后保存即可。

也可以通过环境变量配置（参考 `.env.example`）：

```bash
PORT=3000
TZ=Asia/Shanghai
DB_PATH=./data/esim.db
TELEGRAM_BOT_TOKEN=你的BotToken
TELEGRAM_CHAT_ID=你的ChatID
# 每日提醒时间
NOTIFY_HOUR=9

# 登录保护（同时设置用户名和密码后启用）
AUTH_USERNAME=admin
AUTH_PASSWORD=your_strong_password
AUTH_SECRET=your_random_secret
```

## 运行测试

```bash
npm test
```
