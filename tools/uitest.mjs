/* UI 交互自测：用 CDP 驱动本机 Edge，真实点击/拖拽，验证关键流程。
 *
 *   node tools/uitest.mjs [baseUrl]
 *
 * 零依赖：node 22+ 自带 WebSocket。需要本机装有 Edge 或 Chrome。
 * 输出 PASS/FAIL，并把截图写到 tmp/shots/。
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const BASE_ARG = process.argv[2];
const PORT_SVC = 8800 + Math.floor(Math.random() * 180);
const PORT = 9100 + Math.floor(Math.random() * 400);
let BASE = BASE_ARG || `http://127.0.0.1:${PORT_SVC}`;

const CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];
const BIN = CANDIDATES.find((p) => existsSync(p));
if (!BIN) {
  console.error('[x] 找不到 Edge 或 Chrome');
  process.exit(2);
}

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
      `--user-data-dir=C:\\Temp\\pdfx-uitest-${PORT}`,
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
    return {
      moved: [Math.round(t1.bbox[0] - t0.bbox[0]), Math.round(t1.bbox[1] - t0.bbox[1])],
      before, after: [Math.round(t3.bbox[2] - t3.bbox[0]), Math.round(t3.bbox[3] - t3.bbox[1])],
    };
  })()`);
  check('文本框可以拖动移动', tmove.moved && Math.abs(tmove.moved[0]) > 10, tmove.err || JSON.stringify(tmove.moved));
  check('文本框可以拖角缩放', tmove.after && tmove.after[0] > tmove.before[0] + 5,
    tmove.err || `${JSON.stringify(tmove.before)} → ${JSON.stringify(tmove.after)}`);

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
    let blue = 0, seen = 0;
    for (let py = 0; py < h; py++) {
      for (let px = 0; px < w; px++) {
        const ax = x + px, ay = y + py;
        if (nb && ax >= nb[0] && ax <= nb[2] && ay >= nb[1] && ay <= nb[3]) continue;
        seen++;
        const i = (py * w + px) * 4;
        if (d[i + 2] > 150 && d[i] < 110 && d[i + 1] < 160) blue++;
      }
    }
    return { blue, total: seen };
  })()`);
  check('移动后原位没有图片残影', ghost.blue != null && ghost.total > 0 && ghost.blue / ghost.total < 0.02,
    ghost.err || `原位蓝色像素 ${ghost.blue} / ${ghost.total}（${(100 * ghost.blue / Math.max(1, ghost.total)).toFixed(1)}%）`);

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

  // ---- 橡皮：擦掉页面原有内容（扫描件/文字页，而不只是自己画的笔迹）----
  console.log('\n== 橡皮：擦掉页面原有内容 ==');
  const contentErase = await ev(`(async () => {
    const mk = (t, x, y, b, pid) => new PointerEvent(t, { clientX: x, clientY: y, bubbles: true, cancelable: true, pointerId: pid, pointerType: 'mouse', isPrimary: true, button: 0, buttons: b });
    // 切到有内容的文档（sample_mixed）
    const items = [...document.querySelectorAll('#doclist .docitem')];
    const target = items.find((el) => /sample_mixed/.test(el.textContent));
    if (!target) return { err: '找不到 sample_mixed 文档' };
    target.click();
    await new Promise((z) => setTimeout(z, 1800));
    const img = () => document.querySelector('#pages .pbox.current img');
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
    const before = await dark();
    const beforeSrc = img().src;
    document.querySelector('[data-tool="erase"]').click();
    await new Promise((z) => setTimeout(z, 250));
    const scope = (document.querySelector('#era-scope') || {}).value;
    const pageNo = +document.querySelector('#pages .pbox.current').dataset.page;
    const im = img();
    const r = im.getBoundingClientRect();
    // 横着来回扫三遍，压过页面顶部那几行正文（文字区就在 8%~19% 高度）
    let pid = 90;
    for (const frac of [0.085, 0.14, 0.185]) {
      const y0 = r.top + r.height * frac;
      im.dispatchEvent(mk('pointerdown', r.left + 30, y0, 1, ++pid));
      for (let i = 1; i <= 44; i++) im.dispatchEvent(mk('pointermove', r.left + 30 + i * 9, y0, 1, pid));
      im.dispatchEvent(mk('pointerup', r.left + 430, y0, 0, pid));
      await new Promise((z) => setTimeout(z, 900));
    }
    await new Promise((z) => setTimeout(z, 1800));
    const after = await dark();
    const toast = (document.querySelector('#toast') || {}).textContent || '';
    return { before, after, scope, pageNo, toast, beforeSrc, afterSrc: img().src };
  })()`);
  check('橡皮默认范围是「笔迹 + 页面内容」', contentErase.scope === 'all', String(contentErase.scope || contentErase.err));
  check('橡皮把页面原有内容擦掉（页面位图变浅）', contentErase.after < contentErase.before - 3,
    `第 ${contentErase.pageNo} 页 深色像素 ${contentErase.before} → ${contentErase.after}｜${contentErase.toast}`);
  check('擦除结果里报了删掉的文字数量', /文字\s*\d+\s*处/.test(contentErase.toast || ''), contentErase.toast);
  check('擦完页面位图已重新拉取', contentErase.afterSrc !== contentErase.beforeSrc);

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

  const ocrAfter = await ev(`(async () => {
    document.querySelector('#btn-ocr').click();
    for (let i = 0; i < 80; i++) {
      await new Promise((z) => setTimeout(z, 250));
      if (document.querySelectorAll('#objlist .tag.ocr').length > 0) break;
    }
    return {
      ocrTag: document.querySelectorAll('#objlist .tag.ocr').length,
      rows: document.querySelectorAll('#objlist .obj').length,
      toast: (document.querySelector('#toast') || {}).textContent,
    };
  })()`);
  check('点「识别本页」之后文字才出现', ocrAfter.ocrTag > 0,
    `${ocrAfter.ocrTag} 行 OCR｜${ocrAfter.toast}`);
  await shot('ocr-manual');

  console.log(`\n合计 ${pass} 项通过，${fail} 项失败`);
  if (errors.length) {
    console.log('\n捕获到的前端异常：');
    [...new Set(errors)].slice(0, 6).forEach((e) => console.log('  ! ' + e.split('\n')[0]));
  }

  ws.close();
  killTree(proc);
  if (svc) killTree(svc);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('[x] 测试中断：', e.message);
  process.exit(3);
});
