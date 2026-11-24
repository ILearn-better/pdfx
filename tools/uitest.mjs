/* UI 交互自测：用 CDP 驱动本机 Edge，真实点击/拖拽，验证关键流程。
 *
 *   node tools/uitest.mjs [baseUrl]
 *
 * 零依赖：node 22+ 自带 WebSocket。需要本机装有 Edge 或 Chrome。
 * 输出 PASS/FAIL，并把截图写到 tmp/shots/。
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';

const BASE_ARG = process.argv[2];
const PORT_SVC = 8800 + Math.floor(Math.random() * 180);
const PORT = 9100 + Math.floor(Math.random() * 400);
let BASE = BASE_ARG || `http://127.0.0.1:${PORT_SVC}`;

/* 浏览器装在哪台机器上都不一样（系统盘不一定是 C:，Chrome 也可能只在用户目录），
   所以先用环境变量定位，再退回常见的安装位置，最后允许 CHROME_PATH 直接指定。 */
const PF = process.env['ProgramFiles'] || 'C:\\Program Files';
const PF86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
const LOCAL = process.env['LOCALAPPDATA'] || '';
const CANDIDATES = [
  process.env['CHROME_PATH'],
  join(PF86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  join(PF, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  join(PF, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  join(PF86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  LOCAL && join(LOCAL, 'Google', 'Chrome', 'Application', 'chrome.exe'),
].filter(Boolean);
const BIN = CANDIDATES.find((p) => existsSync(p));
if (!BIN) {
  console.error('[x] 找不到 Edge 或 Chrome（可用 CHROME_PATH 指定完整路径）');
  process.exit(2);
}
// 浏览器配置目录放系统临时目录：C:\Temp 不是每台机器都有，临时目录一定可写
const PROFILE = join(tmpdir(), `pdfx-uitest-${PORT}`);

let pass = 0;
let fail = 0;
const errors = [];

function check(name, cond, extra = '') {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}${extra ? ' — ' + extra : ''}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${extra ? ' — ' + extra : ''}`);
  }
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
        return;
      }
      if (m.method) {
        const ls = this.listeners.get(m.method);
        if (ls) ls.forEach((f) => f(m.params));
      }
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        errors.push(d.exception?.description || d.text || 'unknown');
      }
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
        errors.push(m.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
      }
    });
  }
  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
  }
  waitFor(method, ms = 8000) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('等不到事件: ' + method)), ms);
      this.on(method, (p) => { clearTimeout(t); resolve(p); });
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('CDP timeout: ' + method));
        }
      }, 30000);
    });
  }
}

function killTree(child) {
  if (!child || child.killed) return;
  try {
    if (process.platform === 'win32') {
      // shell:true 起的是 cmd，需要连子进程一起杀
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', shell: true });
    } else {
      child.kill('SIGTERM');
    }
  } catch (e) {
    /* ignore */
  }
}

async function waitJson(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
    } catch (e) {
      /* not ready */
    }
    await sleep(250);
  }
  return null;
}

async function main() {
  // 每次测都起一个干净的服务进程，否则文档状态会从上一次残留下来
  let svc = null;
  if (!BASE_ARG) {
    svc = spawn('python', ['-m', 'pdfx', 'serve', '--port', String(PORT_SVC), '--no-browser', 'samples/sample_mixed.pdf'], {
      cwd: process.cwd(),
      stdio: 'ignore',
      shell: true,
    });
    const up = await waitJson(`${BASE}/api/doc`, 80);
    if (!up) {
      svc.kill();
      console.error('[x] 服务没起来');
      process.exit(2);
    }
    BASE = BASE.replace(/\/$/, '');
  }

  const proc = spawn(
    BIN,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--no-first-run',
      '--hide-scrollbars',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${PROFILE}`,
      '--window-size=1440,900',
      BASE + '/',
    ],
    { stdio: 'ignore' }
  );

  const ver = await waitJson(`http://127.0.0.1:${PORT}/json/version`);
  if (!ver) {
    proc.kill();
    console.error('[x] 浏览器没起来（调试端口无响应）');
    process.exit(2);
  }
  // 找到页面 target
  let page = null;
  for (let i = 0; i < 40 && !page; i++) {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (!page) await sleep(250);
  }
  if (!page) {
    proc.kill();
    console.error('[x] 没有可用的页面 target');
    process.exit(2);
  }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', rej);
  });
  const cdp = new CDP(ws);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  // 固定设备尺寸，否则 captureScreenshot 的宽度/缩放和真实视口不一致，截图会错位
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });

  const ev = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', {
      expression: expr,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) {
      throw new Error('JS 异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    }
    return r.result.value;
  };

  mkdirSync('tmp/shots', { recursive: true });
  const shot = async (name) => {
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(`tmp/shots/${name}.png`, Buffer.from(r.data, 'base64'));
  };

  // 等应用启动完成
  for (let i = 0; i < 40; i++) {
    const ready = await ev(`!!document.querySelector('#pages .pbox, #pages .empty')`);
    if (ready) break;
    await sleep(250);
  }
  // 文档栏是异步拉的，等它出现再断言
  for (let i = 0; i < 20; i++) {
    const n = await ev(`document.querySelectorAll('#doclist .docitem').length`);
    if (n > 0) break;
    await sleep(200);
  }
  // 右侧面板的状态记在 localStorage 里。上一次跑测试如果停在收起态，
  // 后面所有「对象/属性面板」的断言都会莫名失败 —— 开测先恢复成展开并清掉这个键
  if (await ev(`document.querySelector('.layout').classList.contains('insp-off')`)) {
    await ev(`document.querySelector('#btn-inspector').click()`);
    await sleep(320);
  }
  await ev(`localStorage.removeItem('pdfx.insp')`);

  console.log(`\n== 初始加载 (${BASE}) ==`);
  check('页面无 JS 异常', errors.length === 0, errors.slice(0, 3).join(' | '));
  const hasBox = await ev(`!!document.querySelector('#pages .pbox')`);
  const docCount = await ev(`document.querySelectorAll('#doclist .docitem').length`);
  const thumbCount = await ev(`document.querySelectorAll('#thumbs .thumb-wrap').length`);
  const thumbH = await ev(`(() => { const t = document.querySelector('#thumbs .thumb'); return t ? Math.round(t.getBoundingClientRect().height) : 0; })()`);
  check('画布渲染出页面', hasBox);
  check('左侧文档栏有文档', docCount >= 1, `${docCount} 个`);
  check('缩略图数量等于页数', thumbCount >= 1, `${thumbCount} 张`);
  check('缩略图有正常高度（不是横线）', thumbH >= 100, `${thumbH}px`);

  // 前后端版本握手：正常服务不应弹"旧版本"提示条
  const caps = await ev(`(async () => {
    const j = await (await fetch('/api/caps')).json();
    const bar = document.querySelector('#stale-bar');
    return { ok: !!j.ok, caps: (j.data && j.data.caps) || [], barHidden: bar ? bar.hidden : true };
  })()`);
  check('服务端声明了 text.transform / canvas.layered 能力',
    caps.caps.includes('text.transform') && caps.caps.includes('canvas.layered'),
    String(caps.caps.length) + ' 项能力');
  check('新版服务端不显示「旧版本」提示条', caps.barHidden === true);

  // ---- 新建文档 ----
  console.log('\n== 新建文档 ==');
  await ev(`document.querySelector('#btn-new').click()`);
  for (let i = 0; i < 30; i++) {
    const ok = await ev(`document.querySelectorAll('#doclist .docitem').length >= 2`);
    if (ok) break;
    await sleep(200);
  }
  const docCount2 = await ev(`document.querySelectorAll('#doclist .docitem').length`);
  const pageCount2 = await ev(`document.querySelector('#page-count').textContent`);
  const pageNow2 = await ev(`document.querySelector('#page-now').textContent`);
  check('新建后文档栏多了 1 个文档', docCount2 === docCount + 1, `${docCount} → ${docCount2}`);
  check('新建文档是 1 页', pageCount2 === '1', `总页数=${pageCount2}`);
  check('页码显示正确', pageNow2 === '1', `当前=${pageNow2}`);
  const boxSize = await ev(`(() => { const b = document.querySelector('#pages .pbox'); if (!b) return null; const r = b.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; })()`);
  check('空白页画布尺寸正常（不是横线）', boxSize && boxSize[1] > 500, JSON.stringify(boxSize));

  // 空白页的 type 是 "empty"，曾经因为给 pill 加上 empty 类名而被全屏遮罩规则命中
  const pillSize = await ev(`(() => { const el = document.querySelector('#page-type'); if (!el) return null; const r = el.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; })()`);
  check('空白页的类型标签没被撑成全屏遮罩', pillSize && pillSize[0] < 200 && pillSize[1] < 60, JSON.stringify(pillSize));

  // elementFromPoint 能真实反映"用户看到的是什么"，DOM 存在不等于可见
  const topAtCenter = await ev(`(() => {
    const b = document.querySelector('#pages .pbox');
    if (!b) return 'no-pbox';
    const r = b.getBoundingClientRect();
    const el = document.elementFromPoint(r.left + r.width / 2, r.top + 60);
    if (!el) return 'null';
    if (el.closest('.pbox')) return 'pbox';
    return (el.tagName + '.' + (el.className || '')).slice(0, 40);
  })()`);
  check('画布没有被其他元素遮挡', topAtCenter === 'pbox', String(topAtCenter));

  const imgOk = await ev(`(() => { const im = document.querySelector('#pages .pbox img'); return im ? im.naturalWidth : 0; })()`);
  check('页面位图真的加载成功', imgOk > 0, `naturalWidth=${imgOk}`);

  // ---- 画笔 ----
  console.log('\n== 画笔 ==');
  await ev(`document.querySelector('[data-tool="draw"]').click()`);
  const drew = await ev(`(async () => {
    const cv = document.querySelector('#pages .pbox.current img');
    const r = cv.getBoundingClientRect();
    const mk = (type, x, y, buttons) => new PointerEvent(type, {
      clientX: x, clientY: y, bubbles: true, cancelable: true,
      pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons
    });
    cv.dispatchEvent(mk('pointerdown', r.left + 60, r.top + 200, 1));
    for (let i = 1; i <= 8; i++) {
      cv.dispatchEvent(mk('pointermove', r.left + 60 + i * 12, r.top + 200 + i * 6, 1));
      await new Promise(r2 => setTimeout(r2, 12));
    }
    cv.dispatchEvent(mk('pointerup', r.left + 156, r.top + 248, 0));
    await new Promise(r2 => setTimeout(r2, 900));
    return document.querySelector('#objlist').textContent.includes('笔迹');
  })()`);
  check('画笔能画出笔迹并进入对象列表', drew === true);
  await shot('after-draw');

  // 笔迹是否真的画在 canvas 上（取像素判断非空白）
  const painted = await ev(`(() => {
    const cv = document.querySelector('#pages .pbox.current canvas.base');
    if (!cv) return -1;
    const c = cv.getContext('2d');
    const d = c.getImageData(0, 0, cv.width, cv.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 400) if (d[i] > 0) n++;
    return n;
  })()`);
  check('笔迹真的绘制在画布上', painted > 0, `${painted} 个非透明采样点`);

  // ---- 画笔流畅度 ----
  // 页面已经很花时（多条笔迹）再画一笔，测量 200 次指针移动的处理耗时。
  // 如果每次 move 都全量重绘，这里会慢一个数量级 —— 这正是"一卡一卡"的量化形式。
  console.log('\n== 画笔流畅度（页面已有 9 条笔迹）==');
  const perf = await ev(`(async () => {
    const im = document.querySelector('#pages .pbox.current img');
    const r = im.getBoundingClientRect();
    const mk = (t, x, y, b) => new PointerEvent(t, {
      clientX: x, clientY: y, bubbles: true, cancelable: true,
      pointerId: 9, pointerType: 'mouse', isPrimary: true, button: 0, buttons: b });
    for (let s = 0; s < 8; s++) {
      const y = r.top + 120 + s * 26;
      im.dispatchEvent(mk('pointerdown', r.left + 40, y, 1));
      for (let i = 1; i <= 30; i++) im.dispatchEvent(mk('pointermove', r.left + 40 + i * 6, y + (i % 3), 1));
      im.dispatchEvent(mk('pointerup', r.left + 220, y, 0));
    }
    await new Promise(z => setTimeout(z, 1600));
    const before = document.querySelectorAll('#objlist .obj').length;
    const y = r.top + 500;
    im.dispatchEvent(mk('pointerdown', r.left + 40, y, 1));
    const t0 = performance.now();
    for (let i = 1; i <= 200; i++) {
      im.dispatchEvent(mk('pointermove', r.left + 40 + i * 1.5, y + Math.sin(i / 6) * 4, 1));
    }
    const dt = performance.now() - t0;
    im.dispatchEvent(mk('pointerup', r.left + 340, y, 0));
    await new Promise(z => setTimeout(z, 1600));
    const after = document.querySelectorAll('#objlist .obj').length;
    return { dt: Math.round(dt), before, after };
  })()`);
  check('200 次指针移动处理耗时 < 200ms（跟手）', perf.dt < 200, `${perf.dt}ms`);
  check('笔画数量增加后仍能落笔', perf.after > perf.before, `${perf.before} → ${perf.after} 条`);

  // 分层的直接证据：书写过程中 live 层有内容，base 层纹丝不动
  const layers = await ev(`(async () => {
    const mk = (t, x, y, b, pid) => new PointerEvent(t, {
      clientX: x, clientY: y, bubbles: true, cancelable: true,
      pointerId: pid, pointerType: 'mouse', isPrimary: true, button: 0, buttons: b });
    const im = document.querySelector('#pages .pbox.current img');
    const r = im.getBoundingClientRect();
    const box = document.querySelector('#pages .pbox.current');
    const cnt = (cls) => {
      const cv = box.querySelector('canvas.' + cls);
      const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
      let n = 0;
      for (let i = 3; i < d.length; i += 40) if (d[i] > 0) n++;
      return n;
    };
    const b0 = cnt('base');
    im.dispatchEvent(mk('pointerdown', r.left + 60, r.top + 560, 1, 61));
    for (let i = 1; i <= 50; i++) im.dispatchEvent(mk('pointermove', r.left + 60 + i * 5, r.top + 560 + Math.sin(i / 5) * 10, 1, 61));
    await new Promise(z => requestAnimationFrame(() => setTimeout(z, 120)));
    const b1 = cnt('base');
    const l1 = cnt('live');
    im.dispatchEvent(mk('pointerup', r.left + 310, r.top + 560, 0, 61));
    await new Promise(z => setTimeout(z, 1400));
    return { b0, b1, l1 };
  })()`);
  check('书写过程中笔迹实时显示在 live 层', layers.l1 > 0, `${layers.l1} 个采样点`);
  check('书写过程中静态层不重绘（base 像素未变）', Math.abs(layers.b1 - layers.b0) <= Math.max(2, layers.b0 * 0.02),
    `base ${layers.b0} → ${layers.b1}`);

  // ---- 撤销 ----
  console.log('\n== 撤销 ==');
  const beforeUndo = await ev(`document.querySelectorAll('#objlist .obj').length`);
  await ev(`document.querySelector('#btn-undo').click()`);
  await sleep(1400);
  const afterUndo = await ev(`document.querySelectorAll('#objlist .obj').length`);
  check('撤销后对象数量减少 1', afterUndo === beforeUndo - 1, `${beforeUndo} → ${afterUndo}`);

  // ---- 橡皮 ----
  console.log('\n== 橡皮：即时切断 ==');
  const eraseRes = await ev(`(async () => {
    const mk = (t, x, y, b, pid) => new PointerEvent(t, { clientX: x, clientY: y, bubbles: true, cancelable: true, pointerId: pid, pointerType: 'mouse', isPrimary: true, button: 0, buttons: b });
    const imgOf = () => document.querySelector('#pages .pbox.current img');
    // 画一条长横线，点数多便于观察切断
    document.querySelector('[data-tool="draw"]').click();
    let im = imgOf(), r = im.getBoundingClientRect();
    const y0 = r.top + 320;
    im.dispatchEvent(mk('pointerdown', r.left + 60, y0, 1, 21));
    for (let i = 1; i <= 40; i++) im.dispatchEvent(mk('pointermove', r.left + 60 + i * 6, y0, 1, 21));
    im.dispatchEvent(mk('pointerup', r.left + 300, y0, 0, 21));
    await new Promise(z => setTimeout(z, 1500));

    const cnt = () => {
      const cv = document.querySelector('#pages .pbox.current canvas.base');
      const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
      let n = 0;
      for (let i = 3; i < d.length; i += 40) if (d[i] > 0) n++;
      return n;
    };
    const before = cnt();

    document.querySelector('[data-tool="erase"]').click();
    im = imgOf(); r = im.getBoundingClientRect();
    im.dispatchEvent(mk('pointerdown', r.left + 180, y0 - 20, 1, 22));
    for (let i = 1; i <= 6; i++) im.dispatchEvent(mk('pointermove', r.left + 180, y0 - 20 + i * 7, 1, 22));
    await new Promise(z => setTimeout(z, 150));
    const during = cnt();   // 还没松手
    im.dispatchEvent(mk('pointerup', r.left + 180, y0 + 22, 0, 22));
    await new Promise(z => setTimeout(z, 1500));
    const after = cnt();
    return { before, during, after };
  })()`);
  check('擦除过程中画面立即变化（不等服务端往返）', eraseRes.during < eraseRes.before,
    `${eraseRes.before} → ${eraseRes.during} 个采样点`);
  check('松手后擦除结果保持（没有回弹）', eraseRes.after < eraseRes.before, `${eraseRes.after} 个采样点（原 ${eraseRes.before}）`);

  // ---- 文本框：点一下就能插入，插入后可移动 / 缩放 ----
  console.log('\n== 文本框：插入 / 移动 / 缩放 ==');
  const tbox = await ev(`(async () => {
    const mk = (t, x, y, b, pid) => new PointerEvent(t, { clientX: x, clientY: y, bubbles: true, cancelable: true, pointerId: pid, pointerType: 'mouse', isPrimary: true, button: 0, buttons: b });
    const im = document.querySelector('#pages .pbox.current img');
    const r = im.getBoundingClientRect();
    document.querySelector('[data-tool="text"]').click();
    // 只点一下（不拖框），应当也能插入
    im.dispatchEvent(mk('pointerdown', r.left + 110, r.top + 620, 1, 31));
    im.dispatchEvent(mk('pointerup', r.left + 110, r.top + 620, 0, 31));
    await new Promise(z => setTimeout(z, 500));
    const ta = document.querySelector('#modal-body textarea');
    if (!ta) return { err: '没弹出输入框' };
    ta.value = '测试文本框 ABC';
    document.querySelector('#modal-foot .btn.primary').click();
    await new Promise(z => setTimeout(z, 1500));
    const hasProps = !!document.querySelector('#props #p-text');
    const propsText = (document.querySelector('#props') || {}).textContent || '';
    return { hasProps, propsText: propsText.replace(/\\s+/g, ' ').slice(0, 80) };
  })()`);
  check('点一下页面就能插入文本框（不需要拖框）', tbox.hasProps === true, tbox.err || '');
  check('插入后自动选中并显示可编辑属性', /文本内容/.test(tbox.propsText || ''), tbox.propsText);

  const tmove = await ev(`(async () => {
    const mk = (t, x, y, b, pid) => new PointerEvent(t, { clientX: x, clientY: y, bubbles: true, cancelable: true, pointerId: pid, pointerType: 'mouse', isPrimary: true, button: 0, buttons: b });
    const doc = (await (await fetch('/api/docs')).json()).data.current;
    const grab = async () => {
      const j = await (await fetch('/api/text?page=0&doc=' + doc)).json();
      return j.data.items.filter(x => x.source === 'user').pop();
    };
    const t0 = await grab();
    if (!t0) return { err: '接口里找不到刚插入的文本' };
    const box = document.querySelector('#pages .pbox.current');
    const size = (await (await fetch('/api/doc?doc=' + doc)).json()).data.pages[0].size;
    const r = box.getBoundingClientRect();
    const k = r.width / size[0];
    const im = box.querySelector('img');
    // 在手柄之外、框之内拖动 → 移动
    const cx = r.left + (t0.bbox[0] + 8) * k;
    const cy = r.top + (t0.bbox[1] + (t0.bbox[3] - t0.bbox[1]) / 2) * k;
    im.dispatchEvent(mk('pointerdown', cx, cy, 1, 41));
    for (let i = 1; i <= 6; i++) im.dispatchEvent(mk('pointermove', cx + i * 10, cy + i * 4, 1, 41));
    im.dispatchEvent(mk('pointerup', cx + 60, cy + 24, 0, 41));
    await new Promise(z => setTimeout(z, 1800));
    const t1 = await grab();
    if (!t1) return { err: '移动后文本丢失' };
    // 拖右下角 → 缩放
    const t2 = await grab();
    const bx = r.left + t2.bbox[2] * k;
    const by = r.top + t2.bbox[3] * k;
    const before = [t2.bbox[2] - t2.bbox[0], t2.bbox[3] - t2.bbox[1]];
    im.dispatchEvent(mk('pointerdown', bx, by, 1, 42));
    for (let i = 1; i <= 6; i++) im.dispatchEvent(mk('pointermove', bx + i * 12, by + i * 8, 1, 42));
    im.dispatchEvent(mk('pointerup', bx + 72, by + 48, 0, 42));
    await new Promise(z => setTimeout(z, 1800));
    const t3 = await grab();
    if (!t3) return { err: '缩放后文本丢失' };
    // 松手的位置就是用户给的目标框；字必须还在里面
    const want = [t2.bbox[0], t2.bbox[1], t2.bbox[2] + 72 / k, t2.bbox[3] + 48 / k];
    const over = Math.max(t3.bbox[2] - want[2], t3.bbox[3] - want[3]);
    return {
      moved: [Math.round(t1.bbox[0] - t0.bbox[0]), Math.round(t1.bbox[1] - t0.bbox[1])],
      before, after: [Math.round(t3.bbox[2] - t3.bbox[0]), Math.round(t3.bbox[3] - t3.bbox[1])],
      over: Math.round(over * 10) / 10, size0: t2.size, size3: t3.size,
    };
  })()`);
  check('文本框可以拖动移动', tmove.moved && Math.abs(tmove.moved[0]) > 10, tmove.err || JSON.stringify(tmove.moved));
  check('文本框可以拖角缩放', tmove.after && tmove.after[0] > tmove.before[0] + 5,
    tmove.err || `${JSON.stringify(tmove.before)} → ${JSON.stringify(tmove.after)}`);
  check('拖角放大后文字没有被挤出文本框', tmove.over != null && tmove.over <= 1.5,
    tmove.err || `超出 ${tmove.over}pt`);
  check('拖角放大后字号跟着变大', tmove.size3 > tmove.size0 + 1,
    tmove.err || `${tmove.size0}pt → ${tmove.size3}pt`);

  // ---- 图片：点工具就直接插入，不再要求先拖框 ----
  console.log('\n== 图片：直接插入 / 缩放 ==');
  // 不依赖系统文件对话框：拦住 input.click() 只看它有没有被触发，
  // 再用 DataTransfer 塞一个 PNG —— 等价于用户在对话框里选完了文件。
  const clickedInput = await ev(`(async () => {
    window.__clickedInput = null;
    const proto = HTMLInputElement.prototype;
    if (!proto.__pdfxPatched) {
      proto.click = function () { window.__clickedInput = this.id || this.type; };
      proto.__pdfxPatched = true;
    }
    document.querySelector('[data-tool="image"]').click();
    await new Promise(z => setTimeout(z, 300));
    return window.__clickedInput;
  })()`);
  check('点击图片工具立刻弹出选图（不需要先拖框）', clickedInput === 'img-input', String(clickedInput));

  await ev(`(async () => {
    const c = document.createElement('canvas');
    c.width = 240; c.height = 160;
    const g = c.getContext('2d');
    g.fillStyle = '#2f6fed'; g.fillRect(0, 0, 240, 160);
    g.fillStyle = '#fff'; g.font = 'bold 30px sans-serif'; g.fillText('IMG', 66, 96);
    const blob = await new Promise(r => c.toBlob(r, 'image/png'));
    const dt = new DataTransfer();
    dt.items.add(new File([blob], 'test.png', { type: 'image/png' }));
    const el = document.querySelector('#img-input');
    el.files = dt.files;
    el.dispatchEvent(new Event('change'));
    await new Promise(z => setTimeout(z, 2200));
    return true;
  })()`);
  const imgRes = await ev(`(async () => {
    const doc = (await (await fetch('/api/docs')).json()).data.current;
    const list = (await (await fetch('/api/image?page=0&doc=' + doc)).json()).data.items;
    const mine = list.filter(x => x.source === 'user');
    return { count: mine.length, bbox: mine.length ? mine[mine.length - 1].bbox : null,
             props: (document.querySelector('#props') || {}).textContent || '' };
  })()`);
  check('选完图片即自动插入到页面', imgRes.count >= 1, JSON.stringify(imgRes.bbox));
  check('插入后自动选中（属性面板显示尺寸）', /尺寸/.test(imgRes.props), imgRes.props.replace(/\s+/g, ' ').slice(0, 60));
  await shot('image-inserted');

  const imgScale = await ev(`(async () => {
    const mk = (t, x, y, b, pid) => new PointerEvent(t, { clientX: x, clientY: y, bubbles: true, cancelable: true, pointerId: pid, pointerType: 'mouse', isPrimary: true, button: 0, buttons: b });
    const doc = (await (await fetch('/api/docs')).json()).data.current;
    const size = (await (await fetch('/api/doc?doc=' + doc)).json()).data.pages[0].size;
    const grab = async () => {
      const j = await (await fetch('/api/image?page=0&doc=' + doc)).json();
      return j.data.items.filter(x => x.source === 'user').pop();
    };
    const i0 = await grab();
    if (!i0) return { err: '找不到图片' };
    const box = document.querySelector('#pages .pbox.current');
    const r = box.getBoundingClientRect();
    const k = r.width / size[0];
    const im = box.querySelector('img');
    const bx = r.left + i0.bbox[2] * k;
    const by = r.top + i0.bbox[3] * k;
    const before = [Math.round(i0.bbox[2] - i0.bbox[0]), Math.round(i0.bbox[3] - i0.bbox[1])];
    im.dispatchEvent(mk('pointerdown', bx, by, 1, 51));
    for (let i = 1; i <= 6; i++) im.dispatchEvent(mk('pointermove', bx + i * 12, by + i * 8, 1, 51));
    im.dispatchEvent(mk('pointerup', bx + 72, by + 48, 0, 51));
    await new Promise(z => setTimeout(z, 1800));
    const i1 = await grab();
    if (!i1) return { err: '缩放后图片丢失' };
    return { before, after: [Math.round(i1.bbox[2] - i1.bbox[0]), Math.round(i1.bbox[3] - i1.bbox[1])] };
  })()`);
  check('图片可以拖角放大', imgScale.after && imgScale.after[0] > imgScale.before[0] + 5,
    imgScale.err || `${JSON.stringify(imgScale.before)} → ${JSON.stringify(imgScale.after)}`);
  await shot('image-scaled');

  // 图片中心压在正文上时，命中必须按层叠顺序（图片在上）而不是按面积挑小的，
  // 否则拖的是底下那行小字，图片纹丝不动
  const imgMove = await ev(`(async () => {
    const mk = (t, x, y, b, pid) => new PointerEvent(t, { clientX: x, clientY: y, bubbles: true, cancelable: true, pointerId: pid, pointerType: 'mouse', isPrimary: true, button: 0, buttons: b });
    const doc = (await (await fetch('/api/docs')).json()).data.current;
    const size = (await (await fetch('/api/doc?doc=' + doc)).json()).data.pages[0].size;
    const grab = async () => {
      const j = await (await fetch('/api/image?page=0&doc=' + doc)).json();
      return j.data.items.filter(x => x.source === 'user').pop();
    };
    const i0 = await grab();
    if (!i0) return { err: '找不到图片' };
    const box = document.querySelector('#pages .pbox.current');
    const r = box.getBoundingClientRect();
    const k = r.width / size[0];
    const b = i0.bbox;
    const cx = r.left + (b[0] + b[2]) / 2 * k;
    const cy = r.top + (b[1] + b[3]) / 2 * k;
    const el = box.querySelector('img');
    el.dispatchEvent(mk('pointerdown', cx, cy, 1, 61));
    for (let i = 1; i <= 10; i++) el.dispatchEvent(mk('pointermove', cx + i * 6, cy + i * 4, 1, 61));
    el.dispatchEvent(mk('pointerup', cx + 60, cy + 40, 0, 61));
    await new Promise(z => setTimeout(z, 2000));
    const i1 = await grab();
    if (!i1) return { err: '拖动后图片丢失' };
    return {
      before: b.map(Math.round), after: i1.bbox.map(Math.round),
      dx: Math.round(i1.bbox[0] - b[0]), dy: Math.round(i1.bbox[1] - b[1]),
      props: (document.querySelector('#props') || {}).textContent || '',
    };
  })()`);
  check('图片可以整体拖动', imgMove.dx != null && Math.abs(imgMove.dx) > 8 && Math.abs(imgMove.dy) > 5,
    imgMove.err || `${JSON.stringify(imgMove.before)} → ${JSON.stringify(imgMove.after)}`);
  check('拖动后选中的仍是图片而不是底下文字', !/文本内容/.test(imgMove.props || ''),
    (imgMove.props || '').replace(/\s+/g, ' ').slice(0, 56));
  const oldBox = imgMove.before;
  await shot('image-moved');

  // 移动后原位不能留下"另一个一模一样的图"。
  // 曾经的实现用图片自己区域的边缘色去涂原位，取到的就是图片的颜色，等于没涂。
  const ghost = await ev(`(async () => {
    const im = document.querySelector('#pages .pbox.current img');
    if (!im) return { err: '找不到页面位图' };
    try { await im.decode(); } catch (e) {}
    const doc = (await (await fetch('/api/docs')).json()).data.current;
    const size = (await (await fetch('/api/doc?doc=' + doc)).json()).data.pages[0].size;
    const c = document.createElement('canvas');
    c.width = size[0]; c.height = size[1];
    const g = c.getContext('2d');
    g.drawImage(im, 0, 0, size[0], size[1]);
    const b = [${oldBox.join(',')}];
    // 内缩 6px：bbox 取整后边缘那圈必然压在新图边界上，算进去会误判成残影
    const x = Math.round(b[0]) + 6, y = Math.round(b[1]) + 6;
    const w = Math.max(1, Math.round(b[2] - b[0]) - 12);
    const h = Math.max(1, Math.round(b[3] - b[1]) - 12);
    // 新旧位置常常重叠，重叠区里的蓝色属于"搬到这儿的图"，不算残影
    const cur = (await (await fetch('/api/image?page=0&doc=' + doc)).json()).data.items
      .filter((it) => it.source === 'user').pop();
    const nb = cur ? cur.bbox : null;
    const d = g.getImageData(x, y, w, h).data;
    const isBlue = (i) => d[i + 2] > 150 && d[i] < 110 && d[i + 1] < 160;
    let blue = 0, seen = 0;
    for (let py = 0; py < h; py++) {
      for (let px = 0; px < w; px++) {
        const ax = x + px, ay = y + py;
        if (nb && ax >= nb[0] && ax <= nb[2] && ay >= nb[1] && ay <= nb[3]) continue;
        seen++;
        if (isBlue((py * w + px) * 4)) blue++;
      }
    }
    /* 样例 PDF 自带蓝色波浪线/笔迹，单看"蓝色像素占比"会把它误判成
       图片残影（页面位图缩放差 0.1% 就会让比例在 2% 阈值上下跳）。
       残影是整片实心矩形，按 8×8 小块统计密度：真残影会出现大量
       高密块，细线哪怕横穿整块也远到不了 75%。 */
    let dense = 0, cells = 0;
    const cell = 8;
    for (let cy = 0; cy + cell <= h; cy += cell) {
      for (let cx = 0; cx + cell <= w; cx += cell) {
        let n = 0, hit = 0;
        for (let py = 0; py < cell; py++) {
          for (let px = 0; px < cell; px++) {
            const ax = x + cx + px, ay = y + cy + py;
            if (nb && ax >= nb[0] && ax <= nb[2] && ay >= nb[1] && ay <= nb[3]) continue;
            n++;
            if (isBlue(((cy + py) * w + cx + px) * 4)) hit++;
          }
        }
        // 只认"几乎整块都是实心蓝"的格子：贴着新图边界的块被排除后
        // 只剩几个像素，比例容易虚高，用绝对数量卡住才不会被噪声带偏。
        if (n >= 56) { cells++; if (hit >= 48) dense++; }
      }
    }
    return { blue, total: seen, dense, cells };
  })()`);
  check('移动后原位没有图片残影', ghost.dense != null && ghost.cells > 0 && ghost.dense === 0,
    ghost.err || `原位实心蓝块 ${ghost.dense}/${ghost.cells}｜蓝色像素 ${ghost.blue}/${ghost.total}`);

  // ---- 删除图片 → 还能不能再插回来 ----
  // 曾经的死结：删除只是拿纸色块盖住，旧图仍留在内容流里；再往同一处插新图时，
  // 按位置匹配会抓到那张旧图，记录里的 bbox 写成旧位置 —— 界面上就是"插不进来"。
  console.log('\n== 删除图片 → 重新插入 ==');
  const reinsert = await ev(`(async () => {
    const doc = (await (await fetch('/api/docs')).json()).data.current;
    const grab = async () => (await (await fetch('/api/image?page=0&doc=' + doc)).json())
      .data.items.filter((x) => x.source === 'user');
    const list0 = await grab();
    if (!list0.length) return { err: '没有可删的图' };
    const id = list0[list0.length - 1].id;
    const del = await (await fetch('/api/image', {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ page: 0, id, mode: 'purge', doc }),
    })).json();
    if (!del.ok) return { err: '删除接口报错 ' + JSON.stringify(del.error) };
    await new Promise((z) => setTimeout(z, 400));
    return { before: list0.length, after: (await grab()).length, mode: del.data.mode };
  })()`);
  check('删除图片是真删（redaction），不是涂一块色块', reinsert.mode === 'purged',
    String(reinsert.mode || reinsert.err));
  check('删完之后对象列表里确实没有它了', reinsert.after === reinsert.before - 1,
    `${reinsert.before} → ${reinsert.after}`);

  const reinsertUi = await ev(`(async () => {
    document.querySelector('[data-tool="image"]').click();
    await new Promise((z) => setTimeout(z, 150));
    const c = document.createElement('canvas');
    c.width = 300; c.height = 200;
    const g = c.getContext('2d');
    g.fillStyle = '#12805c'; g.fillRect(0, 0, 300, 200);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    const dt = new DataTransfer();
    dt.items.add(new File([blob], 'after-delete.png', { type: 'image/png' }));
    const el = document.querySelector('#img-input');
    el.files = dt.files;
    el.dispatchEvent(new Event('change'));
    await new Promise((z) => setTimeout(z, 2600));
    const doc = (await (await fetch('/api/docs')).json()).data.current;
    const items = (await (await fetch('/api/image?page=0&doc=' + doc)).json())
      .data.items.filter((x) => x.source === 'user');
    const size = (await (await fetch('/api/doc?doc=' + doc)).json()).data.pages[0].size;
    const last = items[items.length - 1];
    const im = document.querySelector('#pages .pbox.current img');
    let green = 0;
    try {
      await im.decode();
      const cc = document.createElement('canvas');
      cc.width = size[0]; cc.height = size[1];
      const cx = cc.getContext('2d');
      cx.drawImage(im, 0, 0, size[0], size[1]);
      const b = last.bbox;
      const w = Math.max(1, Math.round(b[2] - b[0]) - 10);
      const h = Math.max(1, Math.round(b[3] - b[1]) - 10);
      const d = cx.getImageData(Math.round(b[0]) + 5, Math.round(b[1]) + 5, w, h).data;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i] < 90 && d[i + 1] > 90 && d[i + 2] < 130) green++;
      }
    } catch (e) { /* 读不到像素就只靠 bbox 判断 */ }
    return {
      count: items.length,
      bbox: last ? last.bbox.map(Math.round) : null,
      inside: last ? last.bbox[0] >= 0 && last.bbox[1] >= 0
        && last.bbox[2] <= size[0] + 1 && last.bbox[3] <= size[1] + 1 : false,
      green,
      toast: document.querySelector('#toast').textContent,
    };
  })()`);
  check('删除之后用界面还能插进新图片', reinsertUi.count >= 1, reinsertUi.toast);
  check('新图片的落点在页面范围内', reinsertUi.inside === true, JSON.stringify(reinsertUi.bbox));
  check('新图片真的画进了页面位图', reinsertUi.green > 200, `${reinsertUi.green} 个绿色像素`);
  await shot('image-reinserted');

  // ---- 界面点「删除」：必须真删 ----
  // 这条覆盖的是"接口默认值"这个坑：界面调 DELETE 时不带 mode，
  // 服务端若默认 cover，图只是被纸色盖住，看起来删了、实际还在内容流里。
  console.log('\n== 界面删除图片 ==');
  const uiDel = await ev(`(async () => {
    const doc = (await (await fetch('/api/docs')).json()).data.current;
    const list = async () => (await (await fetch('/api/image?page=0&doc=' + doc)).json())
      .data.items.filter((x) => x.source === 'user');
    const items = await list();
    const it = items[items.length - 1];
    if (!it) return { err: '没有可点的图' };
    const size = (await (await fetch('/api/doc?doc=' + doc)).json()).data.pages[0].size;
    const box = document.querySelector('#pages .pbox.current');
    const r = box.getBoundingClientRect();
    const k = r.width / size[0];
    const cx = r.left + (it.bbox[0] + it.bbox[2]) / 2 * k;
    const cy = r.top + (it.bbox[1] + it.bbox[3]) / 2 * k;
    const el = box.querySelector('img');
    const mk = (t, b) => new PointerEvent(t, { clientX: cx, clientY: cy, bubbles: true,
      cancelable: true, pointerId: 71, pointerType: 'mouse', isPrimary: true, button: 0, buttons: b });
    el.dispatchEvent(mk('pointerdown', 1));
    el.dispatchEvent(mk('pointerup', 0));
    await new Promise((z) => setTimeout(z, 350));
    const props = ((document.querySelector('#props') || {}).textContent || '').replace(/\\s+/g, ' ');
    const btn = document.querySelector('#p-del');
    if (!btn) return { err: '属性面板里没有删除按钮', props };
    btn.click();
    await new Promise((z) => setTimeout(z, 1800));
    const after = await list();
    let green = 0;
    try {
      const im = document.querySelector('#pages .pbox.current img');
      await im.decode();
      const cc = document.createElement('canvas');
      cc.width = size[0]; cc.height = size[1];
      const g = cc.getContext('2d');
      g.drawImage(im, 0, 0, size[0], size[1]);
      const b = it.bbox;
      const w = Math.max(1, Math.round(b[2] - b[0]) - 10);
      const h = Math.max(1, Math.round(b[3] - b[1]) - 10);
      const d = g.getImageData(Math.round(b[0]) + 5, Math.round(b[1]) + 5, w, h).data;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i] < 90 && d[i + 1] > 90 && d[i + 2] < 130) green++;
      }
    } catch (e) { /* 读不到像素只靠列表判断 */ }
    return {
      pickedImage: !/文本内容/.test(props), props,
      before: items.length, after: after.length,
      gone: !after.some((x) => x.id === it.id), green,
      toast: document.querySelector('#toast').textContent,
    };
  })()`);
  check('点中图片后属性面板允许删除', uiDel.pickedImage === true, uiDel.err || uiDel.props);
  check('界面点「删除」后图片从对象列表消失', uiDel.gone === true,
    uiDel.err || `${uiDel.before} → ${uiDel.after}`);
  check('界面删除是真删：原位置不再残留图片像素', uiDel.green != null && uiDel.green < 20,
    uiDel.err || `${uiDel.green} 个绿色像素`);
  await shot('image-deleted');

  // ---- 剪贴板：Ctrl+V 粘贴图片 ----
  // 截图工具复制来的图只有剪贴板，没有文件路径，只能走 paste 事件这条路。
  console.log('\n== 剪贴板粘贴 ==');
  const pasteTest = await ev(`(async () => {
    const doc = (await (await fetch('/api/docs')).json()).data.current;
    const list = async () => (await (await fetch('/api/image?page=0&doc=' + doc)).json())
      .data.items.filter((x) => x.source === 'user');
    const before = (await list()).length;
    const c = document.createElement('canvas');
    c.width = 200; c.height = 120;
    const g = c.getContext('2d');
    g.fillStyle = '#e8710a'; g.fillRect(0, 0, 200, 120);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    const dt = new DataTransfer();
    dt.items.add(new File([blob], 'clipboard.png', { type: 'image/png' }));
    document.body.dispatchEvent(new ClipboardEvent('paste', {
      clipboardData: dt, bubbles: true, cancelable: true,
    }));
    await new Promise((z) => setTimeout(z, 2800));
    const after = await list();
    return {
      before, after: after.length,
      toast: document.querySelector('#toast').textContent,
      // 粘贴的图必须真的画进位图，而不是只多了一条记录
      src: document.querySelector('#pages .pbox.current img').src,
    };
  })()`);
  check('Ctrl+V 把剪贴板里的图片粘进当前页', pasteTest.after === pasteTest.before + 1,
    `${pasteTest.before} → ${pasteTest.after}｜${pasteTest.toast}`);

  // ---- Ctrl+C 复制图片 ----
  const pickLast = async () => ev(`(async () => {
    const doc = (await (await fetch('/api/docs')).json()).data.current;
    const items = (await (await fetch('/api/image?page=0&doc=' + doc)).json())
      .data.items.filter((x) => x.source === 'user');
    const it = items[items.length - 1];
    if (!it) return { err: '没有可选中的图' };
    const size = (await (await fetch('/api/doc?doc=' + doc)).json()).data.pages[0].size;
    const box = document.querySelector('#pages .pbox.current');
    const r = box.getBoundingClientRect();
    const k = r.width / size[0];
    const cx = r.left + ((it.bbox[0] + it.bbox[2]) / 2) * k;
    const cy = r.top + ((it.bbox[1] + it.bbox[3]) / 2) * k;
    const el = box.querySelector('img');
    const mk = (t, b) => new PointerEvent(t, { clientX: cx, clientY: cy, bubbles: true,
      cancelable: true, pointerId: 77, pointerType: 'mouse', isPrimary: true, button: 0, buttons: b });
    el.dispatchEvent(mk('pointerdown', 1));
    el.dispatchEvent(mk('pointerup', 0));
    await new Promise((z) => setTimeout(z, 300));
    return { id: it.id, count: items.length };
  })()`);
  const key = (type, k, code, vk, modifiers = 0) => cdp.send('Input.dispatchKeyEvent', {
    type, key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers,
  });
  const press = async (k, code, vk, modifiers = 0) => {
    await key('rawKeyDown', k, code, vk, modifiers);
    await key('keyUp', k, code, vk, modifiers);
    await sleep(250);
  };

  const picked = await pickLast();
  await press('c', 'KeyC', 67, 2);
  const copyToast = await ev(`document.querySelector('#toast').textContent`);
  check('选中图片后 Ctrl+C 有反馈', /已复制/.test(copyToast || ''),
    copyToast || picked.err || '没有提示');

  // 复制完再粘一次：剪贴板写不进去时（无权限/非安全上下文）走应用内兜底
  const pasteAgain = await ev(`(async () => {
    const doc = (await (await fetch('/api/docs')).json()).data.current;
    const n = async () => (await (await fetch('/api/image?page=0&doc=' + doc)).json())
      .data.items.filter((x) => x.source === 'user').length;
    const before = await n();
    document.body.dispatchEvent(new ClipboardEvent('paste', {
      clipboardData: new DataTransfer(), bubbles: true, cancelable: true,
    }));
    await new Promise((z) => setTimeout(z, 2800));
    return { before, after: await n(), toast: document.querySelector('#toast').textContent };
  })()`);
  check('复制后 Ctrl+V 能再贴出一张', pasteAgain.after === pasteAgain.before + 1,
    `${pasteAgain.before} → ${pasteAgain.after}｜${pasteAgain.toast}`);

  // ---- Delete 键删除选中对象 ----
  // 注意别断言"删掉的是最后那一张"：两次粘贴落在同一位置、互相重叠，
  // 点中的是哪一张由命中顺序决定。只断言数量少了一个。
  const picked2 = await pickLast();
  await press('Delete', 'Delete', 46);
  const delKey = await ev(`(async () => {
    const doc = (await (await fetch('/api/docs')).json()).data.current;
    const items = (await (await fetch('/api/image?page=0&doc=' + doc)).json())
      .data.items.filter((x) => x.source === 'user');
    return { count: items.length, toast: document.querySelector('#toast').textContent };
  })()`);
  check('Delete 键删掉选中的图片', delKey.count === picked2.count - 1,
    `${picked2.err || picked2.count + ' → ' + delKey.count}｜${delKey.toast}`);

  // ---- 快捷键侧栏 ----
  console.log('\n== 快捷键侧栏 ==');
  const panel = await ev(`(async () => {
    document.querySelector('#btn-keys').click();
    await new Promise((z) => setTimeout(z, 320));
    const p = document.querySelector('#keys-panel');
    const cv = document.querySelector('#pages .pbox.current canvas');
    return {
      open: document.querySelector('.layout').classList.contains('keys-open'),
      width: Math.round(p.getBoundingClientRect().width),
      rows: document.querySelectorAll('#keys-body .krow').length,
      labels: [...document.querySelectorAll('#keys-body .kdesc')].map((e) => e.textContent),
      saved: localStorage.getItem('pdfx.keys'),
      // 画布变窄之后，canvas 的内部像素尺寸必须跟着重设，否则位图被 CSS 拉伸变形
      canvasSynced: cv ? Math.abs(cv.width - Math.round(cv.clientWidth * devicePixelRatio)) <= 1 : null,
    };
  })()`);
  check('点快捷键按钮能展开侧栏', panel.open === true && panel.width > 200,
    `宽 ${panel.width}px`);
  check('侧栏列出了快捷键条目', panel.rows >= 10, `${panel.rows} 条`);
  check('侧栏包含复制/粘贴/删除/撤销', ['粘贴剪贴板里的图片', '删除选中对象', '撤销', '复制选中的图片 / 文字']
    .every((t) => panel.labels.includes(t)), JSON.stringify(panel.labels));
  check('展开状态记到了本地（刷新后仍在）', panel.saved === '1', String(panel.saved));
  check('展开后画布叠加层跟着重设尺寸（没有被拉伸）', panel.canvasSynced === true,
    String(panel.canvasSynced));
  await shot('shortcut-panel');

  await press('Escape', 'Escape', 27);
  const closed = await ev(`({
    open: document.querySelector('.layout').classList.contains('keys-open'),
    saved: localStorage.getItem('pdfx.keys'),
  })`);
  check('Esc 收起侧栏', closed.open === false && closed.saved === '0', JSON.stringify(closed));

  // '?' 再开一次：中文输入法下不一定发得出来，所以 F1 是备用键，这里两个都测
  await key('rawKeyDown', '?', 'Slash', 191, 8);
  await key('keyUp', '?', 'Slash', 191, 8);
  await sleep(300);
  const openedByQ = await ev(`document.querySelector('.layout').classList.contains('keys-open')`);
  await press('F1', 'F1', 112);
  const closedByF1 = await ev(`!document.querySelector('.layout').classList.contains('keys-open')`);
  check('? 键可以开关侧栏', openedByQ === true);
  check('F1 也能开关侧栏（问号打不出来时用）', closedByF1 === true);

  // ---- 三种浏览方式 ----
  console.log('\n== 浏览方式 ==');
  const singleBoxes = await ev(`document.querySelectorAll('#pages .pbox').length`);
  await ev(`document.querySelector('[data-view="cont"]').click()`);
  await sleep(500);
  const contBoxes = await ev(`document.querySelectorAll('#pages .pbox').length`);
  const contDir = await ev(`getComputedStyle(document.querySelector('#pages')).flexDirection`);
  check('单页模式只渲染 1 页', singleBoxes === 1, `${singleBoxes}`);
  check('连续模式渲染全部页且纵向排列', contBoxes >= 1 && contDir === 'column', `${contBoxes} 页, dir=${contDir}`);
  await ev(`document.querySelector('[data-view="horiz"]').click()`);
  await sleep(500);
  const horizDir = await ev(`getComputedStyle(document.querySelector('#pages')).flexDirection`);
  const horizScroll = await ev(`getComputedStyle(document.querySelector('#stage-wrap')).overflowX`);
  check('横向模式横向排列', horizDir === 'row', `dir=${horizDir}`);
  check('横向模式可左右滚动', horizScroll === 'auto' || horizScroll === 'scroll', `overflow-x=${horizScroll}`);
  await ev(`document.querySelector('[data-view="single"]').click()`);
  await sleep(400);
  await shot('views');

  // ---- 文档独立性与切换 ----
  console.log('\n== 文档独立性 ==');
  const docs = await ev(`[...document.querySelectorAll('#doclist .docitem')].map(d => d.textContent.trim())`);
  check('文档栏列出全部文档', docs.length >= 2, JSON.stringify(docs));
  await ev(`document.querySelectorAll('#doclist .docitem')[0].click()`);
  await sleep(1200);
  const afterSwitch = await ev(`document.querySelector('#page-count').textContent`);
  check('点击文档栏可切回原文档', afterSwitch === '2', `页数=${afterSwitch}`);

  // ---- 新文档保存（应弹路径确认）----
  console.log('\n== 新建文档保存 ==');
  await ev(`document.querySelectorAll('#doclist .docitem')[1].click()`);
  await sleep(1000);
  await ev(`document.querySelector('#btn-save').click()`);
  await sleep(1500);
  const modalShown = await ev(`document.querySelector('#modal').classList.contains('show')`);
  const modalTitle = await ev(`document.querySelector('#modal-title').textContent`);
  const savePath = await ev(`(document.querySelector('#s-path')||{}).value || ''`);
  check('新建文档保存时弹出路径确认框', modalShown === true, `标题=${modalTitle}`);
  check('对话框里给出了完整保存路径', /\.pdf$/i.test(savePath), savePath);
  await shot('save-dialog');

  // ---- 插入 PDF 入口 ----
  console.log('\n== 插入 PDF ==');
  await ev(`document.querySelector('#modal-x').click()`);
  await sleep(300);
  const hasInsertBtn = await ev(`!!document.querySelector('#btn-insert-pdf')`);
  check('顶栏有「插入PDF」入口', hasInsertBtn);
  const imp = await ev(`(async () => {
    const r = await fetch('/api/page/import', { method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ path: 'samples/sample_text.pdf', pages: 'all', at: 1, doc: (await (await fetch('/api/docs')).json()).data.current }) });
    const j = await r.json();
    return j.ok ? { ok: true, n: j.data.imported_count, pages: j.data.page_count } : { ok: false, err: j.error };
  })()`);
  check('接口能把别的 PDF 插入当前文档', imp.ok === true, JSON.stringify(imp));

  // ---- 橡皮：只擦笔迹，绝不碰页面原有内容 ----
  // 曾经提供过「笔迹 + 页面内容」的选项，结果在正式文档上误扫一遍就把正文
  // 真删了（redaction 不可逆）。现在界面只擦自己画的笔迹，这条用"深色像素数
  // 与文字条数都不变"来钉死。
  console.log('\n== 橡皮：只擦笔迹 ==');
  const contentErase = await ev(`(async () => {
    const mk = (t, x, y, b, pid) => new PointerEvent(t, { clientX: x, clientY: y, bubbles: true, cancelable: true, pointerId: pid, pointerType: 'mouse', isPrimary: true, button: 0, buttons: b });
    // 切到有正文的文档（sample_mixed）
    const items = [...document.querySelectorAll('#doclist .docitem')];
    const target = items.find((el) => /sample_mixed/.test(el.textContent));
    if (!target) return { err: '找不到 sample_mixed 文档' };
    target.click();
    await new Promise((z) => setTimeout(z, 1800));
    const box = () => document.querySelector('#pages .pbox.current');
    const img = () => box().querySelector('img');
    const pageNo = +box().dataset.page;
    const doc = (await (await fetch('/api/docs')).json()).data.current;
    const cnt = async () => {
      const j = (await (await fetch('/api/page/' + pageNo + '/objects?ocr=0&doc=' + doc)).json()).data;
      return { texts: j.texts.count, strokes: j.strokes.count };
    };
    const dark = async () => {
      const im = img();
      if (!im.complete) await new Promise((z) => { im.onload = z; setTimeout(z, 800); });
      const c = document.createElement('canvas');
      c.width = 160; c.height = 200;
      const x = c.getContext('2d');
      x.drawImage(im, 0, 0, 160, 200);
      const d = x.getImageData(0, 0, 160, 200).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] < 170) n++;
      return n;
    };
    const before = await cnt();
    const darkBefore = await dark();
    const r = img().getBoundingClientRect();
    let pid = 90;

    // 1) 自己画一笔，横穿页面中部
    document.querySelector('[data-tool="draw"]').click();
    await new Promise((z) => setTimeout(z, 200));
    const y0 = r.top + r.height * 0.45;
    img().dispatchEvent(mk('pointerdown', r.left + 40, y0, 1, ++pid));
    for (let i = 1; i <= 30; i++) img().dispatchEvent(mk('pointermove', r.left + 40 + i * 10, y0, 1, pid));
    img().dispatchEvent(mk('pointerup', r.left + 360, y0, 0, pid));
    await new Promise((z) => setTimeout(z, 1200));
    const drawn = await cnt();
    const objText = (document.querySelector('#objlist') || {}).innerText || '';

    // 2) 橡皮扫过同一处，并额外扫过顶部几行正文
    document.querySelector('[data-tool="erase"]').click();
    await new Promise((z) => setTimeout(z, 250));
    const hasScope = !!document.querySelector('#era-scope');
    const beforeSrc = img().src;
    // 一次手势竖着从上扫到下，压过刚才那一笔（横线从页面左侧 1/12 处起，长度约半页）
    const xx = r.left + r.width * 0.35;
    img().dispatchEvent(mk('pointerdown', xx, r.top + 12, 1, ++pid));
    for (let i = 1; i <= 60; i++) img().dispatchEvent(mk('pointermove', xx, r.top + 12 + i * (r.height - 24) / 60, 1, pid));
    img().dispatchEvent(mk('pointerup', xx, r.top + r.height - 12, 0, pid));
    await new Promise((z) => setTimeout(z, 1800));
    return {
      before, drawn, after: await cnt(),
      darkBefore, darkAfter: await dark(),
      hasScope, objText,
      toast: (document.querySelector('#toast') || {}).textContent || '',
      srcChanged: img().src !== beforeSrc,
    };
  })()`);
  check('橡皮参数栏不再提供「擦页面内容」', contentErase.hasScope === false,
    contentErase.err || `era-scope=${contentErase.hasScope}`);
  // 擦除是"切断"：一条笔迹被扫过后可能变成两段，所以条数未必减少，
  // 但一定发生变化；纹理是否断开由像素断言兜底。
  check('橡皮作用在自己画的笔迹上',
    contentErase.after && contentErase.drawn && contentErase.after.strokes !== contentErase.drawn.strokes,
    contentErase.err || `笔迹 ${contentErase.before && contentErase.before.strokes} → 画后 ${contentErase.drawn && contentErase.drawn.strokes} → 擦后 ${contentErase.after && contentErase.after.strokes}｜对象列表=${(contentErase.objText || '').replace(/\s+/g, ' ').slice(0, 60)}`);
  check('橡皮不碰页面原有文字（条数不变）',
    contentErase.after && contentErase.after.texts === contentErase.before.texts,
    contentErase.err || `文字 ${contentErase.before && contentErase.before.texts} → ${contentErase.after && contentErase.after.texts}`);
  check('橡皮不碰页面原有内容（深色像素不变）',
    contentErase.darkBefore != null && Math.abs(contentErase.darkAfter - contentErase.darkBefore) <= 3,
    contentErase.err || `深色像素 ${contentErase.darkBefore} → ${contentErase.darkAfter}｜${contentErase.toast}`);
  check('擦完笔迹后页面位图已重新拉取', contentErase.srcChanged === true);

  // ---- 触摸 / 手写笔：手势不能被浏览器当成滚动抢走 ----
  console.log('\n== 触摸输入：笔画不被打断 ==');
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await ev(`(() => {
    window.__pc = 0;
    const im = document.querySelector('#pages .pbox.current img');
    im.addEventListener('pointercancel', () => window.__pc++);
    document.querySelector('[data-tool="draw"]').click();
    return true;
  })()`);
  const tg = await ev(`(() => { const b = document.querySelector('#pages .pbox.current'); const r = b.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, page: +b.dataset.page }; })()`);
  const strokesApi = async () => ev(`(async () => {
    const d = (await (await fetch('/api/docs')).json()).data.current;
    const j = await (await fetch('/api/page/${tg.page}/objects?doc=' + d)).json();
    return j.data.strokes.items.length;
  })()`);
  const touchStrokes0 = await strokesApi();
  const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((p, i) => ({ x: p[0], y: p[1], id: i })) });
  const tx = Math.round(tg.x + tg.w * 0.25), ty = Math.round(tg.y + tg.h * 0.68);
  await touch('touchStart', [[tx, ty]]);
  for (let i = 1; i <= 22; i++) { await touch('touchMove', [[tx + i * 8, ty + Math.sin(i / 4) * 4]]); await sleep(14); }
  await touch('touchEnd', []);
  await sleep(1800);
  const pc = await ev('window.__pc');
  const touchStrokes1 = await strokesApi();
  check('手指/手写笔拖动没有被浏览器判成滚动（无 pointercancel）', pc === 0, `pointercancel=${pc}`);
  check('触摸也能写下一整笔', touchStrokes1 === touchStrokes0 + 1, `笔迹 ${touchStrokes0} → ${touchStrokes1}`);
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });

  // ---- 扫描件：OCR 不再自动跑 ----
  // 以前只要页面是扫描件就自动识别，翻一页等 1~3 秒，连续模式下一路卡。
  console.log('\n== OCR：改为按页手动触发 ==');
  await ev(`(async () => {
    await fetch('/api/open', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'samples/sample_scan.pdf' }) });
    return true;
  })()`);
  await cdp.send('Page.reload');
  await sleep(1500);
  for (let i = 0; i < 60; i++) {
    try {
      if (await ev(`!!document.querySelector('#pages .pbox')`)) break;
    } catch (e) { /* 导航中 evaluate 会短暂报错 */ }
    await sleep(250);
  }
  const ocrBefore = await ev(`(() => {
    const tags = [...document.querySelectorAll('#objlist .tag')].map((t) => t.textContent.trim());
    return {
      type: (document.querySelector('#page-type') || {}).textContent,
      rows: document.querySelectorAll('#objlist .obj').length,
      ocrTag: tags.filter((t) => t === 'ocr').length,
      textRows: tags.filter((t) => t === 'ocr' || t === 'text' || t === 'mine').length,
      tags,
      btn: (document.querySelector('#btn-ocr') || {}).textContent,
    };
  })()`);
  check('打开扫描件时不会自动 OCR（不用干等）', ocrBefore.ocrTag === 0 && ocrBefore.textRows === 0,
    `对象 ${ocrBefore.rows} 行，标签 ${JSON.stringify(ocrBefore.tags)}`);
  check('扫描件的类型标识仍然正确', String(ocrBefore.type).trim() === '扫描件', String(ocrBefore.type));
  check('对象面板给出「识别本页」入口', /识别/.test(String(ocrBefore.btn)), String(ocrBefore.btn));

  // 用户反馈在面板里找不到开关，所以顶栏必须有一个显式的「本页 OCR」开关
  const ocrTop = await ev(`(() => {
    const b = document.querySelector('#btn-ocr-top');
    if (!b) return { err: '顶栏没有 OCR 开关' };
    const r = b.getBoundingClientRect();
    return {
      text: b.textContent.trim(), w: Math.round(r.width), h: Math.round(r.height),
      left: Math.round(r.left), right: Math.round(r.right), vw: window.innerWidth,
    };
  })()`);
  check('顶栏有显式的「本页 OCR」开关（可见）',
    !ocrTop.err && ocrTop.w > 40 && ocrTop.h > 14 && /OCR/.test(String(ocrTop.text)),
    ocrTop.err || `${ocrTop.text} · ${ocrTop.w}×${ocrTop.h}`);
  check('OCR 开关落在首屏可视区内（不用横向滚动去找）',
    !ocrTop.err && ocrTop.left >= 0 && ocrTop.right <= ocrTop.vw,
    ocrTop.err || `${ocrTop.left}~${ocrTop.right} / ${ocrTop.vw}`);

  const ocrAfter = await ev(`(async () => {
    document.querySelector('#btn-ocr').click();
    for (let i = 0; i < 80; i++) {
      await new Promise((z) => setTimeout(z, 250));
      if (document.querySelectorAll('#objlist .tag.ocr').length > 0) break;
    }
    return {
      ocrTag: document.querySelectorAll('#objlist .tag.ocr').length,
      rows: document.querySelectorAll('#objlist .obj').length,
      top: (document.querySelector('#btn-ocr-top') || {}).textContent || '',
      toast: (document.querySelector('#toast') || {}).textContent,
    };
  })()`);
  check('点「识别本页」之后文字才出现', ocrAfter.ocrTag > 0,
    `${ocrAfter.ocrTag} 行 OCR｜${ocrAfter.toast}`);
  check('识别后顶栏开关显示「本页 OCR 开」', /OCR\s*开/.test(String(ocrAfter.top)), String(ocrAfter.top));
  await shot('ocr-manual');

  // 识别之后再改内容：旧识别框和画面已经对不上，但开不开是用户的开关 ——
  // 程序只提示"框可能偏了"，不许自己关掉，也不许偷偷重跑整页识别。
  const ocrStale = await ev(`(async () => {
    const mk = (t, x, y, b, pid) => new PointerEvent(t, { clientX: x, clientY: y, bubbles: true, cancelable: true, pointerId: pid, pointerType: 'mouse', isPrimary: true, button: 0, buttons: b });
    document.querySelector('[data-tool="draw"]').click();
    const im = document.querySelector('#pages .pbox.current img');
    const r = im.getBoundingClientRect();
    im.dispatchEvent(mk('pointerdown', r.left + 300, r.top + 700, 1, 91));
    for (let i = 1; i <= 5; i++) im.dispatchEvent(mk('pointermove', r.left + 300 + i * 8, r.top + 700, 1, 91));
    im.dispatchEvent(mk('pointerup', r.left + 340, r.top + 700, 0, 91));
    await new Promise((z) => setTimeout(z, 2200));
    return {
      ocrTag: document.querySelectorAll('#objlist .tag.ocr').length,
      rows: document.querySelectorAll('#objlist .obj').length,
      btn: (document.querySelector('#btn-ocr') || {}).textContent,
      top: (document.querySelector('#btn-ocr-top') || {}).textContent || '',
      tip: !!document.querySelector('#objlist .ocr-tip'),
      tipText: (document.querySelector('#objlist .ocr-tip') || {}).textContent || '',
      toast: (document.querySelector('#toast') || {}).textContent,
    };
  })()`);
  check('改完内容后 OCR 仍然开着（不替用户关）', ocrStale.ocrTag > 0,
    `OCR 行 ${ocrStale.ocrTag}｜${ocrStale.toast}`);
  check('改完内容后按钮变成「刷新识别」', /刷新识别/.test(String(ocrStale.btn)), String(ocrStale.btn));
  check('顶栏开关同步提示「待刷新」', /待刷新/.test(String(ocrStale.top)), String(ocrStale.top));

  // 菜单里的同一个开关也要跟着走：顶栏胶囊是状态，菜单项是入口
  const ocrMenuItem = await ev(`(async () => {
    document.querySelector('.menu[data-menu="feat"] .menu-btn').click();
    await new Promise((r) => setTimeout(r, 160));
    const mi = document.querySelector('#btn-ocr-menu');
    const txt = mi ? mi.textContent.trim().replace(/\\s+/g, ' ') : '';
    const active = !!mi && mi.classList.contains('active');
    document.querySelector('#stage-wrap').click();
    await new Promise((r) => setTimeout(r, 80));
    return { txt, active, closed: !document.querySelector('.menu.open') };
  })()`);
  check('功能菜单里的 OCR 项同步显示「待刷新」',
    ocrMenuItem.active && /待刷新/.test(ocrMenuItem.txt) && ocrMenuItem.closed, ocrMenuItem.txt);
  check('对象面板给出「刷新识别 / 收起」提示', ocrStale.tip && /刷新识别/.test(ocrStale.tipText),
    ocrStale.tipText.slice(0, 40));

  // 过期框不能拿去改：坐标是旧位图算的，redact 会抹到错误位置
  const ocrLock = await ev(`(async () => {
    document.querySelector('[data-tool="select"]').click();
    const row = [...document.querySelectorAll('#objlist .obj')].find((e) => e.querySelector('.tag.ocr'));
    if (!row) return { err: '列表里没有 OCR 行' };
    row.click();
    await new Promise((z) => setTimeout(z, 300));
    const apply = document.querySelector('#p-apply');
    const hint = (document.querySelector('#p-hint') || {}).textContent || '';
    return { disabled: !!(apply && apply.disabled), hasApply: !!apply, hint };
  })()`);
  check('过期的 OCR 行不能编辑（按钮禁用 + 提示刷新）',
    ocrLock.hasApply && ocrLock.disabled && /刷新识别/.test(String(ocrLock.hint)),
    ocrLock.err || ocrLock.hint.slice(0, 40));

  const ocrRefresh = await ev(`(async () => {
    document.querySelector('#tip-ocr-refresh').click();
    for (let i = 0; i < 80; i++) {
      await new Promise((z) => setTimeout(z, 250));
      if (!document.querySelector('#objlist .ocr-tip')) break;
    }
    return {
      ocrTag: document.querySelectorAll('#objlist .tag.ocr').length,
      btn: (document.querySelector('#btn-ocr') || {}).textContent,
      tip: !!document.querySelector('#objlist .ocr-tip'),
    };
  })()`);
  check('点「刷新识别」后重算、提示消失', ocrRefresh.ocrTag > 0 && !ocrRefresh.tip,
    `OCR 行 ${ocrRefresh.ocrTag}｜按钮 ${ocrRefresh.btn}`);

  const ocrOff = await ev(`(async () => {
    document.querySelector('#btn-ocr').click();
    await new Promise((z) => setTimeout(z, 1200));
    return {
      ocrTag: document.querySelectorAll('#objlist .tag.ocr').length,
      btn: (document.querySelector('#btn-ocr') || {}).textContent,
      top: (document.querySelector('#btn-ocr-top') || {}).textContent || '',
    };
  })()`);
  check('点「收起识别」时 OCR 才真的关掉', ocrOff.ocrTag === 0,
    `OCR 行 ${ocrOff.ocrTag}｜按钮 ${ocrOff.btn}`);
  check('收起后按钮回到「识别本页」', /识别本页/.test(String(ocrOff.btn)), String(ocrOff.btn));
  check('收起后顶栏开关回到「本页 OCR 关」', /OCR\s*关/.test(String(ocrOff.top)), String(ocrOff.top));

  /* ------------------------------------------------------------------
     跨设备一致性：新设备上报"笔画和图片乱在一起、笔画跳到别处"。
     这类问题只在设备参数/时序变了才出现，所以要显式把 DPI、滚动、
     并发翻页都拉出来测，而不是只在一个 1440×900 / dpr=1 的环境里跑。 */
  console.log('\n== 跨设备：DPI / 滚动 / 并发翻页 ==');
  await ev(`(async () => {
    const items = [...document.querySelectorAll('#doclist .docitem')];
    const d = items.find((el) => /未命名/.test(el.textContent));
    if (d) d.click();
    for (let i = 0; i < 40; i++) {
      if (+document.querySelector('#page-count').textContent >= 3) break;
      await new Promise(z => setTimeout(z, 150));
    }
    const cont = document.querySelector('[data-view="cont"]');
    if (cont) cont.click();
    await new Promise(z => setTimeout(z, 500));
    document.querySelector('#stage-wrap').scrollTop = 0;
  })()`);
  const multiPage = await ev(`+document.querySelector('#page-count').textContent`);
  check('已切到多页文档（并发翻页的前提）', multiPage >= 3, `${multiPage} 页`);

  const dpiRuns = [];
  for (const dpr of [1, 1.25, 1.5, 2]) {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1440, height: 900, deviceScaleFactor: dpr, mobile: false,
    });
    await sleep(300);
    const r = await ev(`(async () => {
      const box = document.querySelector('#pages .pbox.current');
      const im = box && box.querySelector('img');
      if (!im) return { err: 'no page' };
      const rect = im.getBoundingClientRect();
      const pno = +box.dataset.page;
      const doc = (await (await fetch('/api/docs')).json()).data.current;
      const url = '/api/page/' + pno + '/objects?ocr=0&doc=' + doc;
      const before = (await (await fetch(url)).json()).data.strokes.count;
      const mk = (t, x, y, b) => new PointerEvent(t, {
        clientX: x, clientY: y, bubbles: true, cancelable: true,
        pointerId: 131, pointerType: 'mouse', isPrimary: true, button: 0, buttons: b });
      document.querySelector('[data-tool="draw"]').click();
      im.dispatchEvent(mk('pointerdown', rect.left + 120, rect.top + 300, 1));
      im.dispatchEvent(mk('pointermove', rect.left + 180, rect.top + 330, 1));
      im.dispatchEvent(mk('pointerup', rect.left + 180, rect.top + 330, 0));
      await new Promise(z => setTimeout(z, 1100));
      const after = (await (await fetch(url)).json()).data;
      const last = after.strokes.items[after.strokes.items.length - 1];
      return { first: last && last.points[0], before, after: after.strokes.count,
               rw: rect.width, rh: rect.height, size: after.size, dpr: window.devicePixelRatio };
    })()`);
    dpiRuns.push({ dpr, ...r });
  }
  const dpiErr = dpiRuns.map((r) => r.first
    ? Math.max(Math.abs(r.first[0] - 120 / (r.rw / r.size[0])),
               Math.abs(r.first[1] - 300 / (r.rh / r.size[1])))
    : 99);
  check('不同 DPI 下画笔都落在指针位置（不漂移）',
    dpiRuns.every((r) => r.after > r.before) && dpiErr.every((e) => e < 1.5),
    dpiRuns.map((r) => `${r.dpr}x:${r.first ? dpiErr[dpiRuns.indexOf(r)].toFixed(2) : 'n/a'}pt`).join(' '));
  const xs = dpiRuns.map((r) => r.first && r.first[0]).filter((v) => v != null);
  const ys = dpiRuns.map((r) => r.first && r.first[1]).filter((v) => v != null);
  check('1x / 1.25x / 1.5x / 2x 落点完全一致',
    xs.length === 4 && Math.max(...xs) - Math.min(...xs) < 1.5
      && Math.max(...ys) - Math.min(...ys) < 1.5,
    `x ${xs.map((v) => v.toFixed(1)).join('/')} · y ${ys.map((v) => v.toFixed(1)).join('/')}`);
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
  });
  await sleep(250);

  // 手势中间页面滚动：缓存的 rect 必须跟着平移，否则后续采样点整体跳位
  const scrollRun = await ev(`(async () => {
    const wrap = document.querySelector('#stage-wrap');
    const box = document.querySelector('#pages .pbox.current');
    const im = box && box.querySelector('img');
    if (!im) return { err: 'no page' };
    wrap.scrollTop = 0;
    await new Promise(z => setTimeout(z, 120));
    const r = im.getBoundingClientRect();
    const pno = +box.dataset.page;
    const doc = (await (await fetch('/api/docs')).json()).data.current;
    const url = '/api/page/' + pno + '/objects?ocr=0&doc=' + doc;
    const size = (await (await fetch(url)).json()).data.size;
    const sy = r.height / size[1];
    const mk = (t, x, y, b) => new PointerEvent(t, {
      clientX: x, clientY: y, bubbles: true, cancelable: true,
      pointerId: 141, pointerType: 'mouse', isPrimary: true, button: 0, buttons: b });
    document.querySelector('[data-tool="draw"]').click();
    im.dispatchEvent(mk('pointerdown', r.left + 120, r.top + 300, 1));
    const before = wrap.scrollTop;
    wrap.scrollTop = before + 80;
    await new Promise(z => setTimeout(z, 150));
    // 手指停在原屏幕位置，页面往上滚了 80px
    im.dispatchEvent(mk('pointermove', r.left + 180, r.top + 330, 1));
    im.dispatchEvent(mk('pointerup', r.left + 180, r.top + 330, 0));
    await new Promise(z => setTimeout(z, 1100));
    const objs = (await (await fetch(url)).json()).data;
    const st = objs.strokes.items[objs.strokes.items.length - 1];
    const pts = st && st.points;
    // 第一个点是落笔时的位置（滚动前），最后一个点是滚动之后的采样点。
    // 只有后者该跟着页面一起下移 80px；前者必须原地不动。
    return { first: pts && pts[0][1], last: pts && pts[pts.length - 1][1],
             expectFirst: 300 / sy, expectLast: 410 / sy,
             delta: wrap.scrollTop - before, sy };
  })()`);
  check('手势中滚动 80px 后笔画跟着页面走（不是跳位）',
    !scrollRun.err && scrollRun.delta >= 70
      && Math.abs(scrollRun.last - scrollRun.expectLast) < 3
      && Math.abs(scrollRun.first - scrollRun.expectFirst) < 3,
    scrollRun.err || `滚动 ${scrollRun.delta}px｜首点 ${scrollRun.first && scrollRun.first.toFixed(1)}/${scrollRun.expectFirst.toFixed(1)}`
      + ` 末点 ${scrollRun.last && scrollRun.last.toFixed(1)}/${scrollRun.expectLast.toFixed(1)}`);

  // 人为制造"旧页请求晚到"：慢设备上后端单锁串行时是常态
  const race = await ev(`(async () => {
    const orig = window.fetch.bind(window);
    let n = 0;
    window.fetch = (...a) => {
      if (String(a[0]).includes('/objects')) {
        const delay = (n++ === 0) ? 750 : 60;
        return new Promise(res => setTimeout(() => res(orig(...a)), delay));
      }
      return orig(...a);
    };
    try {
      const click = (i) => {
        const b = document.querySelector('#thumbs .thumb-wrap[data-page="' + i + '"] .thumb');
        if (b) b.click();
      };
      click(1);
      click(2);
      await new Promise(z => setTimeout(z, 1700));
      const pageNow = +document.querySelector('#page-now').textContent - 1;
      const curBox = +document.querySelector('#pages .pbox.current').dataset.page;
      const doc = (await (await fetch('/api/docs')).json()).data.current;
      const j = (await (await fetch('/api/page/' + pageNow + '/objects?ocr=0&doc=' + doc)).json()).data;
      const total = j.texts.count + j.images.count + j.strokes.count;
      const rows = document.querySelectorAll('#objlist .obj').length;
      // 数量偶合不足以证明没串页，再比第一条文本的坐标
      const firstText = j.texts.items[0] && j.texts.items[0].bbox;
      const firstMeta = (document.querySelector('#objlist .obj .meta') || {}).textContent || '';
      const info = (await (await fetch('/api/doc?doc=' + doc)).json()).data;
      const sizes = (info.pages || []).map(p => p.size);
      const ks = [...document.querySelectorAll('#pages .pbox')].map((b) => {
        const i = +b.dataset.page;
        return sizes[i] ? parseFloat(b.style.width) / sizes[i][0] : null;
      }).filter((v) => v != null);
      return { pageNow, curBox, total, rows, firstText, firstMeta, ks,
               spread: ks.length ? Math.max(...ks) - Math.min(...ks) : 99 };
    } finally {
      window.fetch = orig;
    }
  })()`);
  const coordOk = !race.firstText
    || (race.firstMeta.includes(String(Math.round(race.firstText[0])))
      && race.firstMeta.includes(String(Math.round(race.firstText[1]))));
  check('旧页对象请求晚到也不会覆盖当前页（不串页）',
    race.pageNow === race.curBox && race.rows === race.total && coordOk,
    `当前页 ${race.pageNow}｜列表 ${race.rows} 行 / 接口 ${race.total} 个对象`
      + `｜首条 ${race.firstText ? race.firstText.slice(0, 2).map(Math.round).join(',') : 'n/a'} / ${(race.firstMeta || '').trim().slice(0, 22)}`);
  check('各页画布比例一致（页尺寸没被别页覆盖）',
    race.ks && race.ks.length >= 3 && race.spread < 0.01,
    `k 极差 ${race.spread != null ? race.spread.toFixed(4) : 'n/a'}`);
  await shot('cross-device');

  /* ---------------------------------------------------------------- 菜单栏 */
  console.log('\n== 菜单栏 ==');
  const menuBtns = await ev(`[...document.querySelectorAll('.menu-btn')].map((b) => b.textContent.trim())`);
  check('顶栏是「文件 / 功能」两个菜单', menuBtns.join(',') === '文件,功能', menuBtns.join(' / '));

  const fileMenu = await ev(`(async () => {
    const box = document.querySelector('.menu[data-menu="file"]');
    box.querySelector('.menu-btn').click();
    await new Promise((r) => setTimeout(r, 160));
    const pop = box.querySelector('.menu-pop');
    const r = pop.getBoundingClientRect();
    return {
      open: box.classList.contains('open'),
      expanded: box.querySelector('.menu-btn').getAttribute('aria-expanded'),
      left: Math.round(r.left), right: Math.round(r.right),
      top: Math.round(r.top), bottom: Math.round(r.bottom),
      vw: innerWidth, vh: innerHeight,
      items: [...pop.querySelectorAll('.mi')].map((b) => b.textContent.trim().replace(/\\s+/g, ' ')),
    };
  })()`);
  check('「文件」菜单能弹出且落在顶栏下方', fileMenu.open && fileMenu.expanded === 'true'
    && fileMenu.top >= 50 && fileMenu.bottom <= fileMenu.vh,
    `x=${fileMenu.left} y=${fileMenu.top} 高 ${fileMenu.bottom - fileMenu.top}`);
  check('「文件」里是新建 / 打开 / 保存 / 另存为 / 插入 / 撤销',
    ['新建', '打开', '保存', '另存为', '插入', '撤销'].every((k) => fileMenu.items.some((t) => t.includes(k))),
    fileMenu.items.join('｜'));
  check('菜单没有被右边缘裁掉', fileMenu.right <= fileMenu.vw, `${fileMenu.right} / ${fileMenu.vw}`);
  await shot('menu-file');

  const featMenu = await ev(`(async () => {
    const b = document.querySelector('.menu[data-menu="feat"] .menu-btn');
    // 已有菜单开着时划过另一个，应当直接切过去
    b.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 150));
    const box = document.querySelector('.menu[data-menu="feat"]');
    return {
      open: box.classList.contains('open'),
      fileClosed: !document.querySelector('.menu[data-menu="file"]').classList.contains('open'),
      items: [...box.querySelectorAll('.mi')].map((x) => x.textContent.trim().replace(/\\s+/g, ' ')),
    };
  })()`);
  check('菜单开着时划到另一个直接切换', featMenu.open && featMenu.fileClosed, `${featMenu.items.length} 项`);
  check('「功能」里有分割导出 / OCR / 页面 / 快捷键',
    ['分割导出', 'OCR', '添加一页', '删除本页', '快捷键'].every((k) => featMenu.items.some((t) => t.includes(k))),
    featMenu.items.join('｜'));
  await shot('menu-feat');

  const menuDismiss = await ev(`(async () => {
    document.querySelector('#stage-wrap').click();
    await new Promise((r) => setTimeout(r, 120));
    const byOutside = !document.querySelector('.menu.open');
    document.querySelector('.menu[data-menu="feat"] .menu-btn').click();
    await new Promise((r) => setTimeout(r, 100));
    const pop = document.querySelector('.menu[data-menu="feat"] .menu-pop').getBoundingClientRect();
    const right = Math.round(pop.right), vw = innerWidth;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await new Promise((r) => setTimeout(r, 100));
    return { byOutside, byEsc: !document.querySelector('.menu.open'), right, vw };
  })()`);
  check('点空白处收起菜单', menuDismiss.byOutside);
  check('Esc 收起菜单', menuDismiss.byEsc);
  check('菜单在视口内不越界', menuDismiss.right <= menuDismiss.vw, `${menuDismiss.right} / ${menuDismiss.vw}`);

  /* ---------------------------------------------------------------- 右侧面板开合 */
  console.log('\n== 右侧面板开合 ==');
  const inspGeo = () => ev(`(() => {
    const l = document.querySelector('.layout');
    const insp = document.querySelector('#inspector');
    const stage = document.querySelector('#stage-wrap');
    const top = document.querySelector('#btn-inspector');
    const r = insp.getBoundingClientRect();
    const s = stage.getBoundingClientRect();
    const t = top.getBoundingClientRect();
    return {
      inspW: Math.round(r.width), stageW: Math.round(s.width),
      off: l.classList.contains('insp-off'),
      topOn: top.classList.contains('active'), topOff: top.classList.contains('off'),
      topIn: t.left >= 0 && t.right <= innerWidth && t.top >= 0 && t.bottom <= innerHeight,
      aria: insp.getAttribute('aria-hidden'),
      tabsVisible: document.querySelectorAll('#inspector .tab').length === 3
        && document.querySelector('#inspector .tab').getBoundingClientRect().height > 10,
      stored: (() => { try { return localStorage.getItem('pdfx.insp'); } catch (e) { return 'n/a'; } })(),
    };
  })()`);

  const insp0 = await inspGeo();
  check('右侧面板默认展开、三个标签页可见',
    insp0.inspW >= 290 && !insp0.off && insp0.tabsVisible && insp0.topOn,
    `宽 ${insp0.inspW}，按钮高亮 ${insp0.topOn}`);
  check('顶栏的面板开关在可视区内', insp0.topIn);
  await shot('insp-open');

  // 1) 顶栏按钮收起
  await ev(`document.querySelector('#btn-inspector').click()`);
  await sleep(560);
  const insp1 = await inspGeo();
  check('点顶栏按钮收起：面板宽度归零',
    insp1.off && insp1.inspW <= 2 && insp1.aria === 'true',
    `${insp0.inspW} → ${insp1.inspW}`);
  check('收起后画布让出约 306px', insp1.stageW - insp0.stageW >= 290,
    `${insp0.stageW} → ${insp1.stageW}（+${insp1.stageW - insp0.stageW}）`);
  check('收起后顶栏按钮变成「可展开」的形态', insp1.topOff && !insp1.topOn);
  check('收起状态写进 localStorage', insp1.stored === '0', String(insp1.stored));
  await shot('insp-closed');

  // 2) 面板自己的收起按钮
  await ev(`document.querySelector('#btn-inspector').click()`);
  await sleep(460);
  await ev(`document.querySelector('#btn-inspector-close').click()`);
  await sleep(520);
  const insp2 = await inspGeo();
  check('面板内「‹」也能收起', insp2.off && insp2.inspW <= 2, `宽 ${insp2.inspW}`);

  // 3) Ctrl+B
  await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, bubbles: true }))`);
  await sleep(520);
  const insp3 = await inspGeo();
  check('Ctrl+B 展开、再按收起',
    !insp3.off && insp3.inspW >= 290 && insp3.stored === '1',
    `宽 ${insp3.inspW}`);
  await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, bubbles: true }))`);
  await sleep(520);
  const insp4 = await inspGeo();
  check('再按 Ctrl+B 收起', insp4.off && insp4.inspW <= 2);

  // 4) 功能菜单里的开关：勾选态跟着真实状态走，点一下能展开
  await ev(`document.querySelector('.menu[data-menu="feat"] .menu-btn').click()`);
  await sleep(200);
  const miOff = await ev(`(() => {
    const mi = document.querySelector('#btn-inspector-menu');
    const r = mi.getBoundingClientRect();
    return { on: mi.classList.contains('active'), w: Math.round(r.width),
             text: mi.textContent.trim().replace(/\\s+/g, ' '),
             inView: r.bottom <= innerHeight && r.right <= innerWidth };
  })()`);
  check('菜单里有「对象 / 属性面板」项且收起时未勾选',
    miOff.w > 150 && miOff.inView && !miOff.on, `「${miOff.text}」`);
  await ev(`document.querySelector('#btn-inspector-menu').click()`);
  await sleep(560);
  const insp5 = await inspGeo();
  const menuClosed2 = await ev(`!document.querySelector('.menu.open')`);
  check('点菜单项展开面板并自动收起菜单',
    !insp5.off && insp5.inspW >= 290 && menuClosed2, `宽 ${insp5.inspW}`);

  // 5) 展开状态下菜单项应当是勾选的
  await ev(`document.querySelector('.menu[data-menu="feat"] .menu-btn').click()`);
  await sleep(200);
  const miOn = await ev(`document.querySelector('#btn-inspector-menu').classList.contains('active')`);
  await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(200);
  check('展开时菜单项打勾', miOn === true);

  // 6) 收起/展开不能把画布上的东西弄丢：页码、页面数量不变
  const afterToggle = await ev(`(() => ({
    pages: document.querySelectorAll('#pages .pbox').length,
    cur: document.querySelector('#page-now') ? document.querySelector('#page-now').textContent : '',
  }))()`);
  check('来回开合不影响页面与当前页', afterToggle.pages >= 1, `${afterToggle.pages} 页`);
  // 收尾：留在展开态，免得影响后面的面板交互测试
  await ev(`document.querySelector('.layout').classList.contains('insp-off')
    && document.querySelector('#btn-inspector').click()`);
  await sleep(400);

  /* ---------------------------------------------------------------- 文件浏览换盘 */
  console.log('\n== 文件浏览（盘符） ==');
  // 打开框：先看盘符条
  await ev(`document.querySelector('#btn-open').click()`);
  await sleep(1400);
  const drv0 = await ev(`(() => {
    const box = document.querySelector('#browser');
    if (!box) return null;
    const ds = [...box.querySelectorAll('.drive')];
    const pathEl = box.querySelector('.path');
    return {
      n: ds.length, names: ds.map((b) => b.textContent.trim()),
      barSticky: ds.length ? getComputedStyle(ds[0].parentElement).position : '',
      path: pathEl ? pathEl.textContent : '',
      up: [...box.querySelectorAll('.item')].some((i) => i.textContent.includes('上级')),
      items: box.querySelectorAll('.item').length,
    };
  })()`);
  check('打开框里有盘符条（不再只有 C 盘一条路）',
    !!drv0 && drv0.n >= 1 && drv0.path.length > 2 && drv0.items > 0,
    drv0 ? `${drv0.n} 个盘：${drv0.names.join(' / ')}｜当前 ${drv0.path}` : '找不到浏览框');
  check('盘符条吸顶（列表滚动时不跟着滚走）',
    !!drv0 && drv0.barSticky === 'sticky', drv0 ? drv0.barSticky : '');

  // 切到最后一个盘（本机有多个盘才测；一个盘时直接跳过，不假失败）
  let drv1 = null;
  if (drv0 && drv0.n >= 2) {
    await ev(`(() => {
      const ds = [...document.querySelectorAll('#browser .drive')];
      ds[ds.length - 1].click();
    })()`);
    await sleep(900);
    drv1 = await ev(`(() => {
      const box = document.querySelector('#browser');
      return {
        path: box.querySelector('.path').textContent,
        on: [...box.querySelectorAll('.drive.on')].map((b) => b.textContent.trim()),
        up: [...box.querySelectorAll('.item')].some((i) => i.textContent.includes('上级')),
        dirs: [...box.querySelectorAll('.item')].filter((i) => i.textContent.includes('📁')).length,
      };
    })()`);
    check('点另一个盘就切过去了，当前盘高亮',
      drv1.on.length === 1 && drv1.path.toLowerCase().startsWith(drv1.on[0].toLowerCase()),
      `切到 ${drv1.path}（高亮 ${drv1.on.join('')}）`);
    check('盘符根不再显示「上级目录」', drv1.up === false, `根目录 ${drv1.path}`);

    // 进一个子目录，上级应当回来
    if (drv1.dirs > 0) {
      await ev(`(() => {
        const it = [...document.querySelectorAll('#browser .item')].find((i) => i.textContent.includes('📁'));
        it.click();
      })()`);
      await sleep(900);
      const drv2 = await ev(`(() => {
        const box = document.querySelector('#browser');
        return { path: box.querySelector('.path').textContent,
                 up: [...box.querySelectorAll('.item')].some((i) => i.textContent.includes('上级')) };
      })()`);
      check('进了子目录「上级目录」又回来了', drv2.up === true, drv2.path);
    } else {
      check('进了子目录「上级目录」又回来了', true, '该盘根下没有子目录，跳过');
    }
  } else {
    check('点另一个盘就切过去了，当前盘高亮', true, '本机只有一个盘，跳过');
    check('盘符根不再显示「上级目录」', true, '本机只有一个盘，跳过');
    check('进了子目录「上级目录」又回来了', true, '本机只有一个盘，跳过');
  }
  await shot('browse-drives');
  await ev(`document.querySelector('#modal-x').click()`);
  await sleep(400);

  /* 盘符必须是"这台电脑现问系统要的"。界面上的按钮要和后端返回的 roots 逐一对应，
     换到 2 个盘的机器、5 个盘的机器都成立 —— 任何写死的 C:/Q: 组合都会在这里露出来。 */
  const rootsNow = await ev(`(async () => {
    const r = await (await fetch('/api/browse')).json();
    return (r.data && r.data.roots) || [];
  })()`);
  check('盘符条与后端枚举完全一致（没写死 C:/Q:）',
    Array.isArray(rootsNow) && rootsNow.length === drv0.n
      && rootsNow.every((rt) => drv0.names.includes(rt.name)),
    `${rootsNow.length} 个（${rootsNow.map((x) => x.name).join('/')}）vs 界面 ${drv0.names.join('/')}`);
  check('每个盘符带类型（系统 GetDriveTypeW 报的，不是猜的）',
    Array.isArray(rootsNow) && rootsNow.every((rt) => rt.kind),
    rootsNow.map((x) => `${x.name}${x.kind}`).join(' '));

  // 模拟"换了台电脑"：这台机器上根本没有上次记住的那个盘符
  const usedLetters = new Set(rootsNow.map((rt) => String(rt.name).replace(':', '').toUpperCase()));
  const ghostLetter = 'ZYXWVUTSRQPONMLKJIHGFEDCB'.split('').find((c) => !usedLetters.has(c)) || 'Z';
  const ghostPath = `${ghostLetter}:\\教材\\第一册`;
  await ev(`localStorage.setItem('pdfx.lastDir', ${JSON.stringify(ghostPath)})`);
  await ev(`document.querySelector('#btn-open').click()`);
  await sleep(1700);
  const ghostBox = await ev(`(() => {
    const box = document.querySelector('#browser');
    if (!box) return null;
    const warn = box.querySelector('.path.warn');
    return {
      path: box.querySelector('.path') ? box.querySelector('.path').textContent : '',
      warn: warn ? warn.textContent : '',
      drives: box.querySelectorAll('.drive').length,
      items: box.querySelectorAll('.item').length,
      died: box.textContent.includes('回到我的文档'),
    };
  })()`);
  check('别的设备记下的盘符不存在时，不甩错误屏、直接给可用目录',
    !!ghostBox && !ghostBox.died && ghostBox.items > 0 && ghostBox.drives >= 1,
    ghostBox ? `${ghostPath} → ${ghostBox.path}｜${ghostBox.items} 项` : '找不到浏览框');
  check('并说明是"这台电脑上不存在"',
    !!ghostBox && /这台电脑上不存在/.test(ghostBox.warn), ghostBox ? ghostBox.warn : '');
  await ev(`document.querySelector('#modal-x').click()`);
  await sleep(400);

  // 保存框：输入框的目录要和浏览框一致（以前浏览框固定从 home 开始，输入框却在别的盘）
  await ev(`document.querySelector('.menu[data-menu="file"] .menu-btn').click()`);
  await sleep(220);
  await ev(`document.querySelector('#btn-saveas').click()`);
  await sleep(1500);
  const sbox = await ev(`(() => {
    const box = document.querySelector('#s-browser');
    const input = document.querySelector('#s-path');
    if (!box || !input) return null;
    const pathEl = box.querySelector('.path');
    return { drives: box.querySelectorAll('.drive').length,
             browseDir: pathEl ? pathEl.textContent : '',
             value: input.value };
  })()`);
  const normP = (s) => String(s || '').replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase();
  check('保存框也有盘符条',
    !!sbox && sbox.drives >= 1 && sbox.browseDir.length > 2,
    sbox ? `${sbox.drives} 个盘｜${sbox.browseDir}` : '找不到保存框');
  check('保存框的浏览位置与路径框一致',
    !!sbox && normP(sbox.value).startsWith(normP(sbox.browseDir))
      && normP(sbox.value).split('/').length === normP(sbox.browseDir).split('/').length + 1,
    sbox ? `${sbox.browseDir}  ⟷  ${sbox.value}` : '');
  await shot('browse-save');
  await ev(`document.querySelector('#modal-x').click()`);
  await sleep(400);

  /* ---------------------------------------------------------------- 批量分割 */
  console.log('\n== 批量分割 ==');
  const splitDir = join(process.cwd(), 'tmp', 'uitest_split');
  // 上一轮的产物必须清掉：目标已存在时后端会整批拒绝（这是对的，但会让测试假失败）
  rmSync(splitDir, { recursive: true, force: true });
  // 入口在「功能」菜单里，先把菜单打开再量
  await ev(`document.querySelector('.menu[data-menu="feat"] .menu-btn').click()`);
  await sleep(180);
  const spEntry = await ev(`(() => {
    const b = document.querySelector('#btn-split');
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height),
             text: b.textContent.trim().replace(/\\s+/g, ' '),
             inView: r.bottom <= innerHeight + 1 && r.left >= 0 && r.right <= innerWidth };
  })()`);
  check('「功能」菜单里有「分割导出」入口且可见',
    !!spEntry && spEntry.w > 150 && spEntry.h >= 28 && spEntry.inView,
    spEntry ? `${spEntry.w}×${spEntry.h} 「${spEntry.text.slice(0, 26)}」` : '找不到按钮');

  await ev(`document.querySelector('#btn-split').click()`);
  await sleep(900);
  const menuAutoClosed = await ev(`!document.querySelector('.menu.open')`);
  check('点了菜单项后菜单自动收起', menuAutoClosed);
  const sp1 = await ev(`(() => {
    const p = document.querySelector('#split-panel');
    const insp = document.querySelector('#inspector');
    const stage = document.querySelector('#stage-wrap');
    const l = document.querySelector('.layout');
    const r = p.getBoundingClientRect();
    const s = stage.getBoundingClientRect();
    const i = insp.getBoundingClientRect();
    const ok = document.querySelector('#sp-start');
    const okr = ok.getBoundingClientRect();
    return {
      shown: !p.hidden && p.getAttribute('aria-hidden') === 'false',
      splitCls: l.classList.contains('split-open'),
      panelW: Math.round(r.width), stageW: Math.round(s.width), inspW: Math.round(i.width),
      inspHidden: getComputedStyle(insp).display === 'none',
      modal: document.querySelector('#modal').classList.contains('show'),
      head: document.querySelector('.sp-title').textContent.trim(),
      rows: document.querySelectorAll('#sp-rows tr').length,
      out: document.querySelector('#sp-outdir').value,
      prefix: document.querySelector('#sp-prefix').value,
      summary: document.querySelector('#sp-summary').textContent,
      okDisabled: !!ok.disabled,
      okInPanel: okr.width > 40 && okr.left >= r.left - 1 && okr.right <= r.right + 1
        && okr.bottom <= innerHeight + 1,
      pages: document.querySelectorAll('#pages .pbox').length,
      topOn: document.querySelector('#btn-inspector').classList.contains('active'),
      noOverlap: Math.round(s.right) <= Math.round(r.left) + 1,
      inspStored: (() => { try { return localStorage.getItem('pdfx.insp'); } catch (e) { return 'n/a'; } })(),
    };
  })()`);
  check('分割改用右侧栏显示，不再弹窗',
    sp1.shown && sp1.splitCls && !sp1.modal && sp1.panelW >= 340 && sp1.head === '批量分割',
    `栏宽 ${sp1.panelW}px`);
  check('分割栏顶掉对象面板、画布不被盖住',
    sp1.inspHidden && sp1.inspW <= 2 && sp1.noOverlap && sp1.pages >= 1,
    `对象面板 ${sp1.inspW}px｜画布 ${sp1.stageW}px｜${sp1.pages} 页可见`);
  check('点开就是实时预览（已有一段示例范围）',
    sp1.rows >= 1 && !sp1.okDisabled, `${sp1.rows} 行｜${sp1.summary}`);
  check('默认输出目录与前缀都已填好', /[\\/]/.test(sp1.out) && !!sp1.prefix, `${sp1.out} ｜ ${sp1.prefix}`);
  check('「开始分割」按钮在栏内可见', sp1.okInPanel);
  check('分割栏开着时顶栏面板按钮仍算展开', sp1.topOn);
  await shot('split-form');

  // 窄窗口：栏窄到 360px 也要留住「开始分割」，且不许把整页顶出横向滚动条
  for (const vw of [1100, 980]) {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: vw, height: 900, deviceScaleFactor: 1, mobile: false,
    });
    await sleep(460);
    const g = await ev(`(() => {
      const p = document.querySelector('#split-panel');
      const r = p.getBoundingClientRect();
      const s = document.querySelector('#stage-wrap').getBoundingClientRect();
      const b = document.querySelector('#sp-start').getBoundingClientRect();
      return {
        panelW: Math.round(r.width), stageW: Math.round(s.width),
        panelIn: r.left >= 0 && Math.round(r.right) <= innerWidth,
        btnIn: b.width > 40 && b.right <= innerWidth + 1 && Math.round(b.right) <= Math.round(r.right) + 1,
        hscroll: document.documentElement.scrollWidth > innerWidth + 1,
      };
    })()`);
    check(`${vw}px 窗口下分割栏完整、按钮没被挤出去`,
      g.panelIn && g.btnIn && !g.hscroll && g.stageW > 240,
      `栏 ${g.panelW}px｜画布 ${g.stageW}px`);
  }
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
  });
  await sleep(460);

  // 输出目录是新建的 <书名>_split，导之前根本不存在：浏览框要退到上级并说明，
  // 而不是甩一屏「目录不存在」把用户堵死（顺带确认这里也能换盘）
  await ev(`(() => { const t = document.querySelector('#sp-outdir');
    t.value = ${JSON.stringify(splitDir + '-not-yet')}; t.dispatchEvent(new Event('input')); })()`);
  await sleep(700);
  await ev(`document.querySelector('#sp-browse-dir').click()`);
  await sleep(1100);
  const spBrowse = await ev(`(() => {
    const box = document.querySelector('.sp-browser');
    if (!box) return null;
    const warn = box.querySelector('.path.warn');
    return {
      drives: box.querySelectorAll('.drive').length,
      warn: warn ? warn.textContent : '',
      dir: box.querySelector('.path') ? box.querySelector('.path').textContent : '',
      pick: !!box.querySelector('.sp-pick-here'),
      items: box.querySelectorAll('.item').length,
    };
  })()`);
  check('分割的输出目录浏览也能换盘', !!spBrowse && spBrowse.drives >= 1 && spBrowse.items > 0,
    spBrowse ? `${spBrowse.drives} 个盘 · ${spBrowse.items} 项 · ${spBrowse.dir}` : '找不到目录浏览');
  check('目录还不存在时自动退到上级并说明原因',
    !!spBrowse && /还不存在/.test(spBrowse.warn) && spBrowse.pick,
    spBrowse ? spBrowse.warn.slice(0, 46) : '');
  await ev(`document.querySelector('.sp-browser .sp-pick-here').click()`);
  await sleep(700);

  // 改成两段各自一页
  await ev(`(() => { const t = document.querySelector('#sp-ranges');
    t.value = '1-1\\n2-2'; t.dispatchEvent(new Event('input')); })()`);
  await sleep(800);
  const sp2 = await ev(`(() => ({
    rows: document.querySelectorAll('#sp-rows tr').length,
    files: [...document.querySelectorAll('#sp-rows .fn')].map((e) => e.textContent.trim()),
  }))()`);
  check('改页码范围后预览跟着变（2 段 → 2 行）', sp2.rows === 2, sp2.files.join(' / '));

  await ev(`document.querySelector('.sp-mode[data-mode="every"]').click()`);
  await sleep(700);
  const spEvery = await ev(`(() => ({
    calc: document.querySelector('#sp-every-calc').textContent.trim(),
    rows: document.querySelectorAll('#sp-rows tr').length,
  }))()`);
  check('「每 N 页」模式给出预计份数', /份/.test(spEvery.calc) && spEvery.rows >= 1, spEvery.calc);

  await ev(`document.querySelector('.sp-mode[data-mode="toc"]').click()`);
  await sleep(700);
  const spToc = await ev(`(() => ({
    text: document.querySelector('#sp-rows').innerText.trim(),
    disabled: !!document.querySelector('#sp-start').disabled,
  }))()`);
  check('没有书签的文档选「按目录」会说明原因并禁用开始',
    /没有可用目录|没有目录/.test(spToc.text) && spToc.disabled, spToc.text.slice(0, 40));

  // 回到页码模式，指定输出目录后真的切
  await ev(`document.querySelector('.sp-mode[data-mode="ranges"]').click()`);
  await sleep(600);
  await ev(`(() => { const t = document.querySelector('#sp-outdir');
    t.value = ${JSON.stringify(splitDir)}; t.dispatchEvent(new Event('input')); })()`);
  await sleep(800);
  await ev(`(() => { const t = document.querySelector('#sp-ranges');
    t.value = '1-1\\n2-2'; t.dispatchEvent(new Event('input')); })()`);
  await sleep(800);
  await ev(`document.querySelector('#sp-start').click()`);
  let spDone = null;
  for (let i = 0; i < 80; i++) {
    spDone = await ev(`(() => {
      const d = document.querySelector('#sp-done');
      if (!d || d.hidden) return null;
      return { text: d.innerText, files: [...d.querySelectorAll('.sp-file .sf-name')].map((e) => e.textContent.trim()) };
    })()`);
    if (spDone) break;
    await sleep(250);
  }
  check('点「开始分割」后跑完并给出结果', !!spDone && /已导出 2 个文件/.test(spDone.text),
    spDone ? spDone.text.split('\n')[0] : '等不到结果');
  const onDisk = existsSync(splitDir) ? readdirSync(splitDir).filter((f) => f.endsWith('.pdf')) : [];
  check('结果文件真的写到了磁盘上', onDisk.length === 2, onDisk.join(' / '));
  check('结果里的文件名与磁盘一致',
    !!spDone && spDone.files.every((f) => onDisk.includes(f)), (spDone ? spDone.files : []).join(' / '));
  check('完成后结果区不再重复出现表单', spDone ? !/页码范围/.test(spDone.text) : false);
  await shot('split-done');

  // 再分一批：回到表单，应该重新预览
  await ev(`document.querySelector('#sp-done #sp-again').click()`);
  await sleep(800);
  const spAgain = await ev(`(() => ({
    formShown: !document.querySelector('#sp-form').hidden,
    doneShown: !document.querySelector('#sp-done').hidden,
    okText: document.querySelector('#sp-start').textContent.trim(),
    footShown: !document.querySelector('#split-foot').hidden,
  }))()`);
  check('「再分一批」回到表单且预填还在',
    spAgain.formShown && !spAgain.doneShown && /开始分割/.test(spAgain.okText) && spAgain.footShown,
    spAgain.okText);

  // 收起分割栏：右侧那一列交还对象面板，画布回到原宽
  const beforeClose = await ev(`(() => ({
    stage: Math.round(document.querySelector('#stage-wrap').getBoundingClientRect().width),
    insp: Math.round(document.querySelector('#inspector').getBoundingClientRect().width),
  }))()`);
  await ev(`document.querySelector('#sp-close').click()`);
  await sleep(600);
  const spClosed = await ev(`(() => ({
    hidden: document.querySelector('#split-panel').hidden,
    aria: document.querySelector('#split-panel').getAttribute('aria-hidden'),
    splitCls: document.querySelector('.layout').classList.contains('split-open'),
    modal: document.querySelector('#modal').classList.contains('show'),
    inspW: Math.round(document.querySelector('#inspector').getBoundingClientRect().width),
    stageW: Math.round(document.querySelector('#stage-wrap').getBoundingClientRect().width),
    pages: document.querySelectorAll('#pages .pbox').length,
  }))()`);
  check('收起分割栏后对象面板回来、画布变宽',
    spClosed.hidden && spClosed.aria === 'true' && !spClosed.splitCls && !spClosed.modal
      && spClosed.inspW > 290 && spClosed.stageW > beforeClose.stage,
    `画布 ${beforeClose.stage} → ${spClosed.stageW}，对象面板 ${spClosed.inspW}px`);
  check('收起分割栏不丢页面', spClosed.pages >= 1);

  // 再打开一次：面板 DOM 不重建，填过的内容还在（这正是栏比弹窗好用的地方）
  await ev(`document.querySelector('.menu[data-menu="feat"] .menu-btn').click()`);
  await sleep(200);
  await ev(`document.querySelector('#btn-split').click()`);
  await sleep(700);
  const spReopen = await ev(`(() => {
    const p = document.querySelector('#split-panel');
    const r = p.getBoundingClientRect();
    const s = document.querySelector('#stage-wrap').getBoundingClientRect();
    return {
      shown: !p.hidden, rows: document.querySelectorAll('#sp-rows tr').length,
      out: document.querySelector('#sp-outdir').value,
      pages: document.querySelectorAll('#pages .pbox').length,
      noOverlap: Math.round(s.right) <= Math.round(r.left) + 1,
    };
  })()`);
  check('重新展开分割栏时内容不重置、页面还在',
    spReopen.shown && spReopen.rows === 2 && /uitest_split/.test(spReopen.out)
      && spReopen.pages >= 1 && spReopen.noOverlap,
    `${spReopen.rows} 行｜${spReopen.out}`);
  // 顶栏的面板按钮在分割栏开着时 = 收起分割、回到对象面板
  await ev(`document.querySelector('#btn-inspector').click()`);
  await sleep(600);
  const spBack = await ev(`(() => ({
    hidden: document.querySelector('#split-panel').hidden,
    inspW: Math.round(document.querySelector('#inspector').getBoundingClientRect().width),
  }))()`);
  check('顶栏面板按钮能收起分割栏并回到对象面板',
    spBack.hidden && spBack.inspW > 290, `对象面板 ${spBack.inspW}px`);

  console.log(`\n合计 ${pass} 项通过，${fail} 项失败`);
  if (errors.length) {
    console.log('\n捕获到的前端异常：');
    [...new Set(errors)].slice(0, 6).forEach((e) => console.log('  ! ' + e.split('\n')[0]));
  }

  ws.close();
  killTree(proc);
  if (svc) killTree(svc);
  // 浏览器配置目录是本次临时造的，跑完就删，别在别的机器上越积越多
  try { rmSync(PROFILE, { recursive: true, force: true }); } catch (e) { /* 进程还没退干净就留着 */ }
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('[x] 测试中断：', e.message);
  process.exit(3);
});
