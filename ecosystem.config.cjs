// PM2 进程配置 —— 单实例部署推荐用 systemd；用 PM2 时可作为替代。
// 用法： pm2 start ecosystem.config.cjs && pm2 save && pm2 startup
//
// 注意：本项目使用 SQLite，必须单实例运行（SQLite 不支持多进程并发写同一文件）。
// 想横向扩容请先迁移到 PostgreSQL，见 docs/DEPLOY.md「扩容路径」。
module.exports = {
  apps: [
    {
      name: 'echopersona',
      script: 'src/server.js',
      cwd: __dirname,
      // 不加 --no-warnings 以免掩盖真实告警；Node 22 的 SQLite 实验性警告无害
      node_args: '--no-warnings',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 20,
      min_uptime: '20s',
      restart_delay: 1500,
      max_memory_restart: '480M',
      env: {
        NODE_ENV: 'production',
      },
      // 日志交给 PM2 轮转，避免无限增长
      error_file: './data/logs/pm2-error.log',
      out_file: './data/logs/pm2-out.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      // 优雅退出：给在途请求和 DB 关闭留时间
      kill_timeout: 8000,
      wait_ready: false,
    },
  ],
};
