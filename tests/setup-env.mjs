/* 测试环境的预加载：把数据目录钉在系统临时目录里。
 *
 * 为什么需要：
 *   tests/unit.test.js 导入了 src/lib/crypto.js → src/config.js，
 *   而 config.js 在模块加载时就读 .env。若不指定 DATA_DIR，它就落到
 *   .env 里的 ./storage，测试跑完会在项目目录里留下 storage/.masterkey
 *   （一个 32 字节的主密钥）。发布工具会把整个项目目录打包上传，
 *   这个密钥于是跟着上去了 —— 这是真实发生过的泄露路径。
 *
 *   ESM 的 import 会被提升到模块顶部，所以「在测试文件里先写
 *   process.env.DATA_DIR = ...」是无效的（那些语句在 import 求值之后才跑）。
 *   只能在预加载阶段设置，也就是本文件。
 *
 * 用法（已在 package.json 的 test 脚本里接好）：
 *   node --import ./tests/setup-env.mjs --test tests/*.test.js
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

if (!process.env.DATA_DIR) {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'echopersona-test-'));
}
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
// 固定主密钥，避免测试去数据目录里生成 .masterkey（那又会带出文件）
process.env.MASTER_KEY = process.env.MASTER_KEY || 'test-master-key-0123456789abcdef';
process.env.BACKUP_INTERVAL_HOURS = process.env.BACKUP_INTERVAL_HOURS || '0';
