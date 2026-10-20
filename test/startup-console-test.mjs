// 登出态启动守卫：OneBot(127.0.0.1:3002) 不可用时，AIChat 必须照样起来并监听控制台端口。
//
// 背景（2026-10-20）：deploy/aichat.service 原来的 ExecStartPre 在 3002 不通时会阻塞
// 180 秒后 exit 1，配合 Restart=always ⇒ 3210 永不监听 ⇒ 控制台打不开 ⇒ 用户连
// 「扫码登录」的网页都进不去。修复后 ExecStartPre 只做有界探测、失败也 exit 0；
// 迟到的 OneBot 由代码侧自愈（src/app.js 的 2 秒端口轮询 + src/onebot.js 的无限退避重连）。
//
// 本测试不碰部署机、不碰 VPS。它做三件事，全部是**真起进程 / 真连端口**，不做字符串匹配：
//   1. 从 deploy/aichat.service 里取出**当前** ExecStartPre，在 3002 不通的环境里真跑：
//      必须 exit 0 且在 30 秒内返回（这条断言就是「修复」的行为面）。
//   2. 用 QQ_AGENT_PORT=<随机高位端口>、QQ_AGENT_DATA_DIR=<临时目录> 真起
//      `node src/server.js`：15 秒内端口可连、`GET /api/status` 返回 200、
//      SIGINT 干净退出（exit 0）、实例锁已释放。临时目录保证不污染仓库内 data/。
//   3. 负向对照：修复前的旧 ExecStartPre 原样复刻（**只把循环次数 180 缩到 3 以缩短
//      等待**，`curl`/`sleep`/超时/`exit 1` 语义不变）在同一个环境里真跑：必须 exit != 0。
//      把 deploy/aichat.service 临时换回旧版再跑本测试，第 1 条就会以超时失败。
//
// 运行：node test/startup-console-test.mjs（已接入 npm test）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UNIT_PATH = path.join(ROOT, 'deploy', 'aichat.service');
const ONEBOT_HOST = '127.0.0.1';
const ONEBOT_PORT = 3002;
const PRE_TIMEOUT_MS = 30_000;   // 「有界」的判据：修复后必须远小于这个时间返回
const START_TIMEOUT_MS = 15_000; // 服务必须在这段时间内监听控制台端口
const EXIT_TIMEOUT_MS = 10_000;  // SIGINT 后必须在这段时间内干净退出

// 修复前的 ExecStartPre（取自 6b16ffe 的 deploy/aichat.service:33）。
// 唯一的改动是 `seq 1 180` → `seq 1 3`（缩短负向对照的等待，语义不变）：
// 3002 不通 ⇒ 循环耗尽 ⇒ stderr 报错 ⇒ exit 1 ⇒ systemd 中止本次启动。
const OLD_EXEC_START_PRE = '/bin/bash -c \'for i in $(seq 1 3); do curl -sf -m 2 -o /dev/null '
  + 'http://127.0.0.1:3002/get_login_info && exit 0; sleep 1; done; '
  + 'echo "OneBot 180 秒内未就绪" >&2; exit 1\'';

let failed = 0;
function pass(name, detail = '') {
  console.log(`  ✓ ${name}${detail ? `（${detail}）` : ''}`);
}
function fail(name, detail) {
  failed++;
  console.log(`  ✗ ${name}`);
  console.log(`      ${String(detail).split('\n').join('\n      ')}`);
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 端口是否可连（800ms 超时，与 src/app.js 的 isPortOpen 同口径）。 */
function isPortOpen(host, port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (result) => { try { socket.destroy(); } catch { /* ignore */ } resolve(result); };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    try { socket.connect(port, host); } catch { done(false); }
  });
}

async function waitPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isPortOpen(ONEBOT_HOST, port, 300)) return true;
    await sleep(100);
  }
  return false;
}

/** 向系统拿一个当前空闲的高位端口（监听 :0 拿号后立刻释放）。 */
function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, ONEBOT_HOST, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** 从 unit 文件里取当前 ExecStartPre 命令（最后一条；本 unit 只有一条）。 */
function readExecStartPre() {
  const text = fs.readFileSync(UNIT_PATH, 'utf8');
  const lines = text.split('\n').filter((line) => line.startsWith('ExecStartPre='));
  assert(lines.length > 0, `${UNIT_PATH} 里找不到 ExecStartPre=`);
  return lines[lines.length - 1].slice('ExecStartPre='.length);
}

/**
 * 真跑一条 ExecStartPre（用 /bin/bash -c，与 systemd 解析后的执行方式一致）。
 * 超过 timeoutMs 就杀整个进程组（它内部会 spawn curl/sleep，必须成组清理）。
 * @returns {Promise<{code:number|null, signal:string|null, stderr:string, stdout:string, ms:number, timedOut:boolean}>}
 */
function runExecStartPre(command, timeoutMs) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn('/bin/bash', ['-c', command], {
      cwd: ROOT,
      detached: true,   // 自成进程组，超时可整组杀
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* ignore */ }
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout = (stdout + chunk).slice(-8000); });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-8000); });
    child.once('exit', (code, signal) => {
      done = true;
      clearTimeout(timer);
      const ms = Date.now() - startedAt;
      resolve({ code, signal, stderr, stdout, ms, timedOut: ms >= timeoutMs && signal != null });
    });
    child.once('error', (error) => {
      done = true;
      clearTimeout(timer);
      resolve({ code: null, signal: null, stderr: String(error?.message ?? error), stdout, ms: Date.now() - startedAt, timedOut: false });
    });
  });
}

/** 真跑一次「服务启动链」：ExecStartPre 必须在有界时间内 exit 0。 */
async function checkExecStartPreIsNonBlocking() {
  const command = readExecStartPre();
  console.log(`     ExecStartPre = ${command}`);
  console.log('     在 3002 不通的环境里真跑当前 ExecStartPre…');
  const result = await runExecStartPre(command, PRE_TIMEOUT_MS);
  const detail = `${result.ms}ms, exit=${result.code}, signal=${result.signal}`;
  if (result.timedOut) {
    fail('当前 ExecStartPre 失败不阻塞', `超过 ${PRE_TIMEOUT_MS}ms 仍未返回（阻塞启动）—— 这正是旧版的故障形态。${detail}\nstderr: ${result.stderr.trim() || '(空)'}`);
    return;
  }
  if (result.code !== 0) {
    fail('当前 ExecStartPre 失败不阻塞', `exit=${result.code}（应 exit 0：OneBot 不可用也必须继续启动）。${detail}\nstderr: ${result.stderr.trim() || '(空)'}`);
    return;
  }
  pass('当前 ExecStartPre 失败不阻塞', detail);
}

/** 真起 node src/server.js：3002 不通时控制台端口必须起来且 /api/status 可用。 */
async function checkServerStartsWithOneBotDown(tag) {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'aichat-startup-'));
  const port = await findFreePort();
  const env = {
    ...process.env,
    QQ_AGENT_PORT: String(port),
    QQ_AGENT_DATA_DIR: tmpdir,
    // 显式固定，避免测试受外部环境（如 PROFILE 偏移）影响；端口已由 QQ_AGENT_PORT 覆盖
    NODE_ENV: 'production'
  };
  let child = null;
  let logs = '';
  let exited = null;
  try {
    child = spawn(process.execPath, ['src/server.js'], {
      cwd: ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const append = (chunk) => { logs = (logs + chunk).slice(-12000); };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.once('exit', (code, signal) => { exited = { code, signal }; });

    const listens = await waitPort(port, START_TIMEOUT_MS);
    if (!listens) {
      throw new Error(`15 秒内没有监听 ${ONEBOT_HOST}:${port}（3002 不通不应阻塞监听）\n--- 进程日志尾部 ---\n${logs.trim()}`);
    }
    pass(`OneBot 不可用时 ${START_TIMEOUT_MS / 1000} 秒内监听控制台端口`, `127.0.0.1:${port}`);

    const res = await fetch(`http://${ONEBOT_HOST}:${port}/api/status`, {
      signal: AbortSignal.timeout(5000)
    });
    const bodyText = await res.text();
    assert(res.status === 200, `/api/status 返回 ${res.status}（应 200）：${bodyText.slice(0, 300)}`);
    pass('GET /api/status 返回 200');

    let status = null;
    try { status = JSON.parse(bodyText); } catch { /* 下面断言会报 */ }
    assert(status && typeof status === 'object', `/api/status 返回的不是 JSON：${bodyText.slice(0, 300)}`);
    assert(status.dataDir === tmpdir, `服务没有用临时数据目录（dataDir=${status.dataDir}，期望 ${tmpdir}）—— 测试可能污染了仓库内 data/`);
    assert(status.onebot && status.onebot.connected === false, `本测试要求 OneBot 不可用（connected=false），实际 ${JSON.stringify(status.onebot)}`);
    pass('数据目录隔离开（没碰仓库 data/），且 onebot.connected=false（登出态）');

    // 清理：SIGINT 走 server.js 的优雅退出路径（app.stop() → exit 0）
    child.kill('SIGINT');
    const deadline = Date.now() + EXIT_TIMEOUT_MS;
    while (!exited && Date.now() < deadline) await sleep(50);
    if (!exited) {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      throw new Error(`SIGINT 后 ${EXIT_TIMEOUT_MS}ms 内没有退出\n--- 进程日志尾部 ---\n${logs.trim()}`);
    }
    assert(exited.code === 0 && exited.signal == null, `SIGINT 后退出码 ${exited.code} / signal ${exited.signal}（应 exit 0）\n--- 进程日志尾部 ---\n${logs.trim()}`);
    pass('SIGINT 干净退出', 'exit=0');

    assert(!fs.existsSync(path.join(tmpdir, 'qq-agent.lock')), '退出后实例锁没有释放（qq-agent.lock 仍在临时数据目录里）');
    pass('退出后实例锁已释放');
  } catch (error) {
    fail(`服务启动链（${tag}）`, error?.message ?? error);
  } finally {
    if (child && !exited) {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }
    try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/** 内置负向对照：修复前的阻塞版 ExecStartPre 在同一环境里必须失败。 */
async function checkOldExecStartPreFails() {
  console.log('     在同一个环境里真跑修复前的旧 ExecStartPre（循环 180→3，其余原样）…');
  const result = await runExecStartPre(OLD_EXEC_START_PRE, PRE_TIMEOUT_MS);
  const detail = `${result.ms}ms, exit=${result.code}, signal=${result.signal}`;
  if (result.timedOut) {
    fail('负向对照：旧 ExecStartPre 必须失败', `旧命令在 ${PRE_TIMEOUT_MS}ms 内没返回（本测试的「有界」断言已足以判它不合规）。${detail}`);
    return;
  }
  if (result.code === 0) {
    fail('负向对照：旧 ExecStartPre 必须失败', `旧命令居然 exit 0（3002 不通时它本应 exit 1）。${detail}`);
    return;
  }
  pass('负向对照：旧 ExecStartPre 必须失败', `${detail}；stderr=${JSON.stringify(result.stderr.trim().slice(0, 120))}`);
}

async function main() {
  console.log('登出态启动守卫（OneBot 127.0.0.1:3002 不可用时控制台仍须可用）');
  console.log(`  仓库：${ROOT}`);
  console.log(`  unit：${path.relative(ROOT, UNIT_PATH)}`);

  // 前置：本测试的前提是「登出态」——3002 不可用。本地有 NapCat 在跑时前提不成立。
  const onebotUp = await isPortOpen(ONEBOT_HOST, ONEBOT_PORT);
  if (onebotUp) {
    fail('前置：环境必须是登出态（3002 不监听）', `${ONEBOT_HOST}:${ONEBOT_PORT} 正在监听 —— 本测试要在 OneBot 不可用时验证控制台启动；请停掉 NapCat/QQ 后重跑`);
  } else {
    pass('前置：OneBot HTTP 不可用（登出态）', `${ONEBOT_HOST}:${ONEBOT_PORT} 未监听`);
    await checkExecStartPreIsNonBlocking();
    await checkServerStartsWithOneBotDown('登出态');
    await checkOldExecStartPreFails();
  }

  console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('测试自身异常:', error);
  process.exit(1);
});
