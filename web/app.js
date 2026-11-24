/* pdfx web 编辑器
 * 坐标：内部统一用 PDF 点（左上原点），显示时乘以 pxPerPt。
 *
 * 浏览方式：single（单页）/ cont（连续纵向）/ horiz（横向左右滚动）
 * 交互只发生在"当前页"的 canvas 上，其余页仅显示位图。
 */
(() => {
  'use strict';

  const PX_PER_PT = 96 / 72;
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));

  const S = {
    doc: null,
    path: null,
    docs: [],
    page: 0,
    pageCount: 0,
    sizes: [],            // 每页 [w,h]（pt）
    zoom: 1,
    view: 'single',
    tool: 'select',
    size: [595, 842],
    type: 'text',
    objs: { texts: [], images: [], strokes: [] },
    sel: null,
    hits: [],
    showText: false,
    forceOcr: false,
    drawing: null,
    erasing: null,
    hoverPt: null,
    dragSelect: null,
    pan: null,
    pendingImage: null,
    busy: false,
    ctxSeq: 0,            // 文档/页面上下文版本：异步请求回来时校验，别把 A 页对象画到 B 页
    rev: 1,               // 后端文档修订号：内容一变就变，位图 URL 用它做缓存键
    sid: '',              // 后端进程标识：重启后换掉，避免拿到上次进程的缓存位图
    ocrPages: new Set(),  // 用户主动开了 OCR 的页 —— 开不开只由用户决定
    ocrStale: new Set(),  // 开着 OCR 但页面内容改过：框按旧位图算的，等用户点刷新
    ocrCache: new Map(),  // page → 上一轮识别结果（跨页翻回来还要能显示，不能拿别页的）
    brush: { color: '#d64545', width: 2.2 },
    eraser: { radius: 10 },   // 只擦自己画的笔迹，绝不碰页面原有内容
    textStyle: { size: 12, color: '#111111' },
  };

  const wrap = $('#stage-wrap');
  const pagesBox = $('#pages');

  /* 分割面板：DOM 只建一次（收起再打开时填好的参数与结果都留着）。
     splitShow 是"展开时刷一下"的钩子 —— 换文档要重新算预览，
     所以 loadInfo 里也会用到它，声明放前面免得踩到 TDZ。 */
  let splitMounted = false;
  let splitShow = null;

  /* 布局阶段用理论比例：此时 DOM 还不存在，没法实测。 */
  const layoutScale = () => S.zoom * PX_PER_PT;

  /* 绘制 / 命中阶段一律用「当前页实际显示宽度 ÷ 页面 pt 宽度」。
     页面位图是被拉到 100% 铺满 .pbox 的，所以这个实测比例才是位图上
     每 pt 对应多少 CSS px。以前写死 zoom*96/72，一旦 box 的实际宽度和
     理论值有出入（浏览器缩放、系统 DPI、侧栏挤压、尺寸取整），叠加层就
     和位图差开 —— 表现就是"笔画和图片对不上、笔画跳到旁边"。
     实测值只依赖 DOM，跟设备参数无关，两台机器结果一致。 */
  let kCache = { stamp: -1, key: '', k: layoutScale() };
  function pxPerPt() {
    const box = currentBox();
    if (!box) return layoutScale();
    const w = sizeOf(S.page)[0];
    const key = `${S.doc}|${S.page}|${S.zoom}|${S.ctxSeq}|${w}`;
    // 一帧（16ms）只量一次：rectOf 在 OCR 结果几百行时每帧会调几百次，
    // 每次 getBoundingClientRect 都会强制同步布局，直接把画笔拖垮。
    const stamp = Math.floor(performance.now() / 16);
    if (kCache.key === key && kCache.stamp === stamp) return kCache.k;
    const r = box.getBoundingClientRect();
    const k = r.width > 0 && w > 0 ? r.width / w : layoutScale();
    kCache = { stamp, key, k };
    return k;
  }

  /* 异步操作开始前抓一份上下文。请求飞在路上的时候用户可能已经翻页，
     回来时若不校验，A 页的图片/笔迹就会被写进 B 页的 S.objs。 */
  function ctxNow() { return { doc: S.doc, page: S.page, seq: S.ctxSeq }; }
  function ctxSame(c) {
    return !!c && c.doc === S.doc && c.page === S.page && c.seq === S.ctxSeq;
  }

  /* ------------------------------------------------------------------ 基础工具 */
  function toast(msg, kind = '') {
    const el = $('#toast');
    el.textContent = msg;
    el.className = 'toast show ' + kind;
    clearTimeout(el._t);
    el._t = setTimeout(() => (el.className = 'toast ' + kind), 2600);
  }

  async function api(path, opts = {}) {
    const o = { headers: {}, ...opts };
    if (o.json !== undefined) {
      o.method = o.method || 'POST';
      o.headers['Content-Type'] = 'application/json';
      o.body = JSON.stringify(o.json);
      delete o.json;
    }
    if (S.doc && !path.includes('doc=')) {
      path += (path.includes('?') ? '&' : '?') + 'doc=' + encodeURIComponent(S.doc);
    }
    const res = await fetch(path, o);
    let data;
    try {
      data = await res.json();
    } catch (e) {
      throw new Error('服务返回异常 (' + res.status + ')');
    }
    if (!data.ok) {
      const err = new Error((data.error && data.error.message) || '操作失败');
      err.code = data.error && data.error.code;
      throw err;
    }
    // 每个响应都带着后端修订号：拿到就更新，位图 URL 立刻跟着变，
    // 不用等下一次 refreshObjects 才知道内容已经改了。
    if (data.data && typeof data.data === 'object') {
      if (typeof data.data.rev === 'number') S.rev = Math.max(S.rev, data.data.rev);
      if (data.data.sid) S.sid = data.data.sid;
    }
    return data.data;
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );
  }

  function fmtSize(n) {
    if (!n) return '';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }

  function baseName(p) {
    if (!p) return '';
    const s = String(p).replace(/\\/g, '/');
    return s.slice(s.lastIndexOf('/') + 1);
  }

  /* ------------------------------------------------------------------ 弹窗 */
  function dialog({ title, html, okText = '确定', cancelText = '取消', wide = false, onMount, onOk }) {
    return new Promise((resolve) => {
      const back = $('#modal');
      back.querySelector('.modal').classList.toggle('wide', !!wide);
      $('#modal-title').textContent = title;
      $('#modal-body').innerHTML = html;
      const foot = $('#modal-foot');
      foot.innerHTML = '';
      foot.hidden = false;
      let cancelBtn = null;
      if (cancelText) {
        const b = document.createElement('button');
        b.className = 'btn';
        b.textContent = cancelText;
        b.onclick = () => close(null);
        foot.appendChild(b);
        cancelBtn = b;
      }
      let okBtn = null;
      if (okText) {
        const b = document.createElement('button');
        b.className = 'btn primary';
        b.textContent = okText;
        // onOk 返回 false = "先别关"：分割这种要跑后台任务、结果还要留在弹窗里的
        // 流程，不能点一下就把窗关了
        b.onclick = async () => {
          if (!onOk) return close(collect());
          b.disabled = true;
          try {
            const v = await onOk(collect(), b);
            if (v === false) {
              b.disabled = false;
              return;
            }
            close(v);
          } catch (e) {
            b.disabled = false;
            toast(e.message || '操作失败', 'err');
          }
        };
        foot.appendChild(b);
        okBtn = b;
      }
      const collect = () => {
        const out = {};
        $$('#modal-body [data-field]').forEach((el) => {
          out[el.dataset.field] = el.type === 'checkbox' ? el.checked : el.value;
        });
        return out;
      };
      function close(v) {
        back.classList.remove('show');
        document.removeEventListener('keydown', onKey);
        resolve(v);
      }
      function onKey(e) {
        if (e.key === 'Escape') close(null);
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) close(collect());
      }
      $('#modal-x').onclick = () => close(null);
      document.addEventListener('keydown', onKey);
      back.classList.add('show');
      const body = $('#modal-body');
      const first = body.querySelector('input, textarea');
      if (first) setTimeout(() => first.focus(), 30);
      if (onMount) {
        onMount(body, close, collect, { ok: okBtn, cancel: cancelBtn });
      }
    });
  }

  async function askText(initial, title = '输入文本') {
    const r = await dialog({
      title,
      html: `<div class="field"><textarea data-field="text" placeholder="输入内容，支持换行">${esc(initial || '')}</textarea></div>`,
    });
    return r ? r.text : null;
  }

  function pickFile(which) {
    const map = { image: '#img-input', pdf: '#pdf-input', pdfopen: '#file-input' };
    return new Promise((resolve) => {
      const el = $(map[which] || '#file-input');
      el.value = '';
      let done = false;
      let timer = 0;
      const finish = (f) => {
        if (done) return;
        done = true;
        el.onchange = null;
        window.removeEventListener('focus', onFocus);
        clearTimeout(timer);
        resolve(f);
      };
      /* 用户在系统文件框里点「取消」时浏览器不发 change 事件。
         以前这里只认 change，取消一次这个 Promise 就永远悬着（后续再点
         「图片」也不会有任何反应）—— 看起来就是"插入图片坏了"。
         窗口重新获得焦点是取消的唯一可靠信号，再留一个超时兜底。 */
      function onFocus() {
        setTimeout(() => {
          if (!el.files || !el.files.length) finish(null);
        }, 500);
      }
      el.onchange = () => finish(el.files[0] || null);
      window.addEventListener('focus', onFocus);
      timer = setTimeout(() => finish(el.files && el.files[0] ? el.files[0] : null), 60000);
      el.click();
    });
  }

  function fileToDataURL(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = reject;
      fr.readAsDataURL(file);
    });
  }

  /* ------------------------------------------------------------------ 渲染：外壳 */
  function syncStageClass() {
    wrap.className = `stage-wrap view-${S.view} tool-${S.tool}`;
  }

  function sizeOf(i) {
    const s = S.sizes[i];
    return Array.isArray(s) && s.length === 2 ? s : S.size;
  }

  function pageSrc(i) {
    // dpi 跟着缩放走；上限 192，再往上单页渲染要 200ms+，画面糊一点比卡住好。
    const dpi = Math.max(60, Math.min(192, Math.round(96 * S.zoom)));
    // s=进程标识、r=修订号：内容一变 URL 就变，可以放心让浏览器长期缓存位图。
    // 以前没有这两个键、后端还把位图也设成 no-store，于是每放大一次就把所有页
    // 重新渲染一遍 —— 这是"整体卡顿"最直接的一环。
    return `/api/page/${i}.png?dpi=${dpi}&doc=${S.doc}&s=${S.sid}&r=${S.rev}`;
  }

  function renderEmpty() {
    pagesBox.innerHTML = `<div class="empty-state">
      <h2>打开或新建一份 PDF</h2>
      <p>点左上角「打开」选文件，或直接把 PDF 拖进这个窗口。</p>
      <div class="empty-actions">
        <button class="btn primary" id="btn-empty-open">打开 PDF</button>
        <button class="btn" id="btn-empty-new">新建空白文档</button>
      </div>
    </div>`;
    $('#btn-empty-open').onclick = () => openFileDialog();
    $('#btn-empty-new').onclick = () => newDocument();
    $('#page-now').textContent = '0';
    $('#page-count').textContent = '0';
    $('#page-type').textContent = '—';
    $('#page-type').className = 'pill';
    $('#objlist').innerHTML = '<div class="empty-list">还没有打开的文档</div>';
  }

  /* 懒加载：连续/横向模式下页数可能很多，只加载视口附近的页 */
  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach((e) => {
        const el = e.target;
        if (!e.isIntersecting || el.dataset.loaded === '1') return;
        el.dataset.loaded = '1';
        const im = el.querySelector('img');
        if (im && im.dataset.src) im.src = im.dataset.src;
      });
    },
    { root: wrap, rootMargin: '700px 0px' }
  );

  /* 按「布局比例」定 .pbox 的尺寸。不取整：位图会被拉到 100% 铺满，
     宽高都按同一个 k 生成，实测比例才严格等于 k（相差不到 0.01px）。
     以前 Math.round 会让宽、高比例各差一点，位图被非等比拉伸，
     叠加层却按理论 k 画 —— DPI/缩放一变，笔画就跟图片错开。 */
  function sizeBox(i, el) {
    const box = el || pagesBox.querySelector(`.pbox[data-page="${i}"]`);
    if (!box) return;
    const [w, h] = sizeOf(i);
    const k = layoutScale();
    box.style.width = Math.max(1, w * k).toFixed(2) + 'px';
    box.style.height = Math.max(1, h * k).toFixed(2) + 'px';
  }

  function renderPages() {
    io.disconnect();
    pagesBox.innerHTML = '';
    if (!S.doc || !S.pageCount) {
      renderEmpty();
      return;
    }
    const list = S.view === 'single' ? [S.page] : Array.from({ length: S.pageCount }, (_, i) => i);
    list.forEach((i) => {
      const box = document.createElement('div');
      box.className = 'pbox' + (i === S.page ? ' current' : '');
      box.dataset.page = i;
      sizeBox(i, box);

      const im = document.createElement('img');
      im.alt = '';
      im.dataset.src = pageSrc(i);
      // 两层画布：base 放静态内容（已提交笔画/文本块/命中/选中框），
      // live 只放正在进行的操作（正在画的线、橡皮轨迹、拖动预览）。
      // 拖动时只清空并重绘 live，开销极小，这是画笔跟手的关键。
      const base = document.createElement('canvas');
      base.className = 'base';
      const live = document.createElement('canvas');
      live.className = 'live';
      box.append(im, base, live);
      pagesBox.appendChild(box);
      io.observe(box);
    });
    drawOverlay();
    syncScrollToCurrent();
  }

  /* 只更新某一页的位图（内容变了但不想重建 DOM） */
  function reloadPageImage(i) {
    const box = pagesBox.querySelector(`.pbox[data-page="${i}"]`);
    if (!box) return;
    const im = box.querySelector('img');
    if (!im) return;
    im.dataset.src = pageSrc(i);
    im.dataset.loaded = '1';
    im.src = im.dataset.src;
    box.dataset.loaded = '1';
  }
  function currentBox() {
    return pagesBox.querySelector(`.pbox[data-page="${S.page}"]`);
  }

  function syncScrollToCurrent() {
    if (S.view === 'single') return;
    const box = currentBox();
    if (!box) return;
    if (S.view === 'cont') {
      wrap.scrollTop = box.offsetTop - 20;
    } else {
      wrap.scrollLeft = box.offsetLeft - 20;
    }
  }

  /* ------------------------------------------------------------------ 页面切换 */
  async function setCurrentPage(n, opts = {}) {
    const { scroll = false, force = false } = opts;
    if (!S.doc) return;
    if (!force && (n < 0 || n >= S.pageCount)) return;
    const changed = n !== S.page;
    if (changed) S.ctxSeq += 1;   // 让飞在路上的旧页请求失效
    S.page = n;
    S.sel = null;
    S.drawing = null;
    S.erasing = null;
    S.dragSelect = null;

    pagesBox.querySelectorAll('.pbox').forEach((b) => b.classList.toggle('current', +b.dataset.page === n));
    markThumbActive();
    $('#page-now').textContent = String(n + 1);

    if (S.view === 'single' && changed) {
      renderPages();
    } else {
      drawOverlay();
      if (scroll) syncScrollToCurrent();
    }
    await refreshObjects();
    renderProps();
  }

  /* 滚动时自动同步"当前页" */
  let scrollTick = 0;
  wrap.addEventListener('scroll', () => {
    if (S.view === 'single' || !S.doc) return;
    if (scrollTick) return;
    scrollTick = requestAnimationFrame(() => {
      scrollTick = 0;
      const boxes = Array.from(pagesBox.querySelectorAll('.pbox'));
      if (!boxes.length) return;
      let best = S.page;
      let bestD = Infinity;
      if (S.view === 'cont') {
        const mid = wrap.scrollTop + wrap.clientHeight / 2;
        boxes.forEach((b) => {
          const d = Math.abs(b.offsetTop + b.offsetHeight / 2 - mid);
          if (d < bestD) { bestD = d; best = +b.dataset.page; }
        });
      } else {
        const mid = wrap.scrollLeft + wrap.clientWidth / 2;
        boxes.forEach((b) => {
          const d = Math.abs(b.offsetLeft + b.offsetWidth / 2 - mid);
          if (d < bestD) { bestD = d; best = +b.dataset.page; }
        });
      }
      if (best !== S.page) setCurrentPage(best);
    });
  }, { passive: true });

  /* ------------------------------------------------------------------ 缩略图 */
  function markThumbActive() {
    $$('#thumbs .thumb-wrap').forEach((t) => t.classList.toggle('active', +t.dataset.page === S.page));
  }

  /* 缩略图懒请求：一百页的文档如果一上来就发一百个请求，后端要串行渲染一百次，
     期间点任何东西都得排队 —— 这是"打开大文件后整个界面卡住"的来源。
     只渲染滚动到可见区域附近的那十几张。 */
  const thumbIO = new IntersectionObserver(
    (entries) => {
      entries.forEach((e) => {
        if (!e.isIntersecting) return;
        const im = e.target.querySelector('img');
        if (im && im.dataset.src && im.src !== im.dataset.src) {
          im.src = im.dataset.src;
          delete im.dataset.src;
        }
        thumbIO.unobserve(e.target);
      });
    },
    { root: $('#thumbs'), rootMargin: '400px 0px' }
  );

  function thumbSrc(i) {
    return `/api/page/${i}/thumb.png?w=150&doc=${S.doc}&s=${S.sid}&r=${S.rev}`;
  }

  function renderThumbs() {
    const box = $('#thumbs');
    thumbIO.disconnect();
    box.innerHTML = '';
    $('#page-count').textContent = String(S.pageCount);
    $('#page-now').textContent = String(S.pageCount ? S.page + 1 : 0);
    if (!S.doc || !S.pageCount) return;
    const frag = document.createDocumentFragment();
    for (let i = 0; i < S.pageCount; i++) {
      const w = document.createElement('div');
      w.className = 'thumb-wrap' + (i === S.page ? ' active' : '');
      w.dataset.page = i;
      const b = document.createElement('button');
      b.className = 'thumb';
      b.title = `第 ${i + 1} 页`;
      const im = document.createElement('img');
      im.alt = '';
      im.dataset.src = thumbSrc(i);
      b.appendChild(im);
      b.onclick = () => setCurrentPage(i, { scroll: true });
      const num = document.createElement('div');
      num.className = 'num';
      num.textContent = String(i + 1);
      w.append(b, num);
      frag.appendChild(w);
    }
    box.appendChild(frag);
    $$('#thumbs .thumb-wrap').forEach((w) => thumbIO.observe(w));
    // 当前页附近的缩略图立刻要（否则首屏一片空白）
    const near = [S.page, S.page - 1, S.page + 1, S.page + 2].filter((i) => i >= 0 && i < S.pageCount);
    near.forEach((i) => {
      const im = box.querySelector(`.thumb-wrap[data-page="${i}"] img`);
      if (im && im.dataset.src) { im.src = im.dataset.src; delete im.dataset.src; }
    });
  }

  function reloadThumb(i) {
    const im = $(`#thumbs .thumb-wrap[data-page="${i}"] img`);
    if (!im) return;
    im.src = thumbSrc(i);
    delete im.dataset.src;
  }

  /* ------------------------------------------------------------------ 文档栏 */
  async function refreshDocList() {
    try {
      const r = await api('/api/docs');
      S.docs = r.docs || [];
      renderDocList();
    } catch (e) { /* 没文档时忽略 */ }
  }

  function renderDocList() {
    const box = $('#doclist');
    box.innerHTML = '';
    $('#doc-count').textContent = String(S.docs.length);
    if (!S.docs.length) {
      box.innerHTML = '<div class="doc-empty">还没有文档</div>';
      return;
    }
    S.docs.forEach((d) => {
      const btn = document.createElement('button');
      btn.className = 'docitem' + (d.doc_id === S.doc ? ' active' : '');
      btn.title = d.path || '未保存（新建文档）';
      btn.innerHTML = `<span class="mini">${d.page_count}</span>
        <span class="nm">${esc(d.name)}</span>
        ${d.modified ? '<span class="mod" title="有未保存的改动"></span>' : ''}`;
      btn.onclick = () => activateDoc(d.doc_id);
      box.appendChild(btn);
    });
  }

  async function activateDoc(did) {
    if (!did || did === S.doc) return;
    try {
      const info = await api('/api/doc/activate', { json: { doc: did } });
      await loadInfo(info);
      toast('已切换到 ' + (baseName(info.path) || did), 'ok');
    } catch (e) { toast(e.message, 'err'); }
  }

  /* ------------------------------------------------------------------ 文档装载 */
  async function loadInfo(info) {
    S.ctxSeq += 1;            // 换文档：旧文档在飞的请求一律不许落地
    S.doc = info.doc_id || info.doc || S.doc;
    S.path = info.path || null;
    // 换文档时修订号必须归零重来：rev 是"每份文档各自"的计数，
    // 沿用上一个文档的大值会让新文档的内容变化不对 URL 生效，
    // 页面就一直显示缓存的旧图（橡皮擦完看着像没擦）。
    S.rev = 0;
    if (typeof info.rev === 'number') S.rev = Math.max(S.rev, info.rev);
    if (info.sid) S.sid = info.sid;
    if (!info.pages) {
      try { info = await api('/api/doc'); S.path = info.path || null; } catch (e) { /* ignore */ }
    }
    S.pageCount = info.page_count || (info.pages ? info.pages.length : 0);
    S.sizes = (info.pages || []).map((p) => p.size || S.size);
    S.page = 0;
    S.sel = null;
    S.hits = [];
    S.ocrPages = new Set();   // OCR 结果按页记，换文档就清空
    S.ocrStale = new Set();
    S.ocrCache = new Map();
    syncStageClass();
    // 先列文档（左侧栏先有内容），再渲染页面，观感上不会"空一下"
    await refreshDocList();
    renderThumbs();
    renderPages();
    await refreshObjects();
    renderProps();
    updateOcrBadge(info.ocr);
    // 分割面板正开着时换了文档：预览表得跟着换，否则显示的还是上一份的页码
    if (splitPanelOpen() && splitShow) splitShow();
  }

  function updateOcrBadge(ocr) {
    const b = $('#ocr-badge');
    if (!ocr) return;
    if (ocr.available) {
      b.className = 'ocr-badge ok';
      b.textContent = 'OCR · ' + (ocr.backend === 'windows' ? '系统' : ocr.backend);
      b.title = ocr.detail || '';
    } else {
      b.className = 'ocr-badge bad';
      b.textContent = 'OCR 不可用';
      b.title = ocr.error || '';
    }
  }

  /* ------------------------------------------------------------------ 对象与叠加层 */
  /* OCR 的开关只有用户能改：点「识别本页」打开，点「收起识别」关闭。
     程序自己绝不去开（翻页不再自动识别），也绝不去关
     （内容改完仍保持开着，只是框可能偏了，标成"待刷新"由用户决定何时重算）。 */
  function ocrOn() {
    return S.ocrPages.has(S.page);
  }
  function ocrStale() {
    return ocrOn() && S.ocrStale.has(S.page);
  }
  /* 过期页面上的 OCR 对象只能看不能改：坐标是旧位图算的，
     拿它去 redact / 覆盖会落到错误位置，把旁边的正文抹掉。 */
  function ocrLocked(o) {
    return !!o && o.source === 'ocr' && ocrStale();
  }
  function warnOcrLocked() {
    toast('这一页内容改过，识别框可能偏了；先点「刷新识别」再编辑这一行', 'err');
  }
  /* 这一次请求是否需要后端真跑 OCR。检索（forceOcr）是用户主动发起，算需要。 */
  function wantOcr() {
    return S.forceOcr || (ocrOn() && !ocrStale());
  }

  let objReq = 0;
  async function refreshObjects() {
    if (!S.doc) return;
    const token = ++objReq;          // 只有最后一次对象请求能落地
    const c = ctxNow();              // 以及它出发时的文档/页面
    const run = wantOcr();
    try {
      const objs = await api(`/api/page/${c.page}/objects?ocr=${run ? 1 : 0}`);
      /* 请求飞在路上的时候翻了页/换了文档，旧响应绝不能写入 S.objs：
         以前会把 A 页的图片、笔迹画到 B 页上（"笔画和图片乱在一起、
         笔画跳到别的位置"），慢设备上更容易撞上。后端是单锁串行处理，
         慢页的响应晚到是常态，不是偶发。 */
      if (token !== objReq || !ctxSame(c)) return;
      if (Number.isInteger(objs.page) && objs.page !== c.page) return;
      const size = Array.isArray(objs.size) && objs.size.length === 2 ? objs.size : S.size;
      // 尺寸按「请求的那一页」存。写成 S.sizes[S.page] 会把 A 页尺寸
      // 记到 B 页名下，之后 B 页位图被按错误比例拉伸，叠加层全跟着偏。
      S.sizes[c.page] = size;
      sizeBox(c.page);
      let texts = objs.texts.items;
      // 开着 OCR 但框已过期：不重跑（整页 1~3 秒），也不把它关掉，
      // 上一轮识别结果原样留着，用户点了「刷新识别」才重算。
      // 取缓存时必须按页取 —— 翻页后 S.objs 已经是别页的了。
      if (ocrOn() && !run) {
        const keep = S.ocrCache.get(c.page) || [];
        if (keep.length) texts = texts.concat(keep);
      }
      S.objs = { texts, images: objs.images.items, strokes: objs.strokes.items };
      // 真正跑过识别：把这一页的结果记下来，之后改内容/翻页回来都还有框可看
      if (run) S.ocrCache.set(c.page, texts.filter((t) => t.source === 'ocr'));
      S.size = size;
      S.type = objs.type;
      $('#page-type').textContent = { text: '结构化文本', scanned: '扫描件', mixed: '混合', empty: '空白页' }[objs.type] || objs.type;
      // 注意类名要加前缀：直接写 'pill empty' 会和页面上的空状态遮罩 .empty 撞名
      $('#page-type').className = 'pill t-' + objs.type;
      syncOcrButton();
      drawOverlay();
      renderObjList();
      if (S.hits.length) renderResults();
    } catch (e) {
      if (token === objReq && ctxSame(c)) toast(e.message, 'err');
    }
  }

  function syncOcrButton() {
    const on = ocrOn();
    const stale = ocrStale();
    // 结构化页本来就有文字层，不需要识别，别让按钮显得"点了没反应"
    const useful = S.type === 'scanned' || S.type === 'mixed';
    const b = $('#btn-ocr');
    if (b) {
      b.textContent = stale ? '刷新识别' : on ? '收起识别' : '识别本页';
      b.classList.toggle('active', on);
      b.disabled = false;
      if (stale) {
        b.title = '这一页内容改过，识别框还是按旧位图算的；点一下重新识别，或点列表里的「收起」关掉';
      } else if (on) {
        b.title = useful ? '收起这一页的识别结果（识别结果仍缓存在后端，再点可继续用）'
          : '收起这一页的额外识别结果';
      } else {
        b.title = useful
          ? '扫描件没有文字层，识别后文字才能被选中、检索（约 1~3 秒）'
          : '这一页本身就有文字层，不需要 OCR；点了会额外识别一次，用来校对图文是否一致';
      }
    }
    // 顶栏那个是显式的开关（用户反馈在对象面板里找不到），和面板按钮同一套状态
    const top = $('#btn-ocr-top');
    if (top) {
      top.textContent = on ? (stale ? '本页 OCR 待刷新' : '本页 OCR 开') : '本页 OCR 关';
      top.classList.toggle('on', on);
      top.classList.toggle('warn', on && stale);
      top.title = stale
        ? '这一页内容改过，识别框可能偏了；点一下重新识别'
        : on
          ? '这一页已开启 OCR；点一下收起识别结果'
          : (useful
            ? '这一页是扫描件，没有文字层：点一下识别本页文字（约 1~3 秒）'
            : '这一页本身就有文字层；如需校对图文是否一致，点一下可额外识别一次');
    }
    // 「功能」菜单里同一开关：菜单项是入口，顶栏胶囊是状态 —— 两处一起走
    const mi = $('#btn-ocr-menu');
    if (mi) {
      mi.classList.toggle('active', on);
      const state = mi.querySelector('.mi-state');
      if (state) state.textContent = on ? (stale ? '待刷新' : '已开启') : '关闭';
    }
  }

  /* 关掉这一页的 OCR 显示（只影响显示，识别结果仍在后端缓存里） */
  async function closeOcrPage() {
    S.ocrPages.delete(S.page);
    S.ocrStale.delete(S.page);
    syncOcrButton();
    await refreshObjects();
    toast('已收起这一页的识别结果', '');
  }

  /* 手动 OCR：只对当前页，结果由后端按图像哈希缓存，翻回来不用再等。
     再点一次 = 收起（把显示关掉），开关始终由用户掌握。 */
  async function doOcrPage(opts = {}) {
    if (!S.doc) return;
    const force = !!opts.force;
    if (!force && ocrOn() && !ocrStale()) {
      await closeOcrPage();
      return;
    }
    if (S.type !== 'scanned' && S.type !== 'mixed') {
      toast('这一页已有文字层，直接选中即可；如需校对可再点一次', '');
    }
    const btn = $('#btn-ocr');
    const old = btn.textContent;
    btn.disabled = true;
    btn.textContent = '识别中…';
    const was = S.forceOcr;
    const wasStale = S.ocrStale.has(S.page);
    S.forceOcr = true;
    try {
      // 正在重算：先摘掉"待刷新"标记，否则 refreshObjects 重建列表时
      // 会照着旧标记又把提示条挂回来（识别完了还显示"可能偏了"）。
      S.ocrStale.delete(S.page);
      await refreshObjects();
      S.ocrPages.add(S.page);
      const n = S.objs.texts.filter((t) => t.source === 'ocr').length;
      toast(n ? `已识别 ${n} 行文字` : '这一页没识别出文字（可能是空白页或图像质量太低）', n ? 'ok' : '');
    } catch (e) {
      // 识别失败：框还是旧的，把"待刷新"提示还原，别让用户以为已经是最新的
      if (wasStale) { S.ocrStale.add(S.page); renderObjList(); }
      toast(e.message, 'err');
    } finally {
      S.forceOcr = was;
      btn.disabled = false;
      syncOcrButton();
      if (btn.textContent === '识别中…') btn.textContent = old;
    }
  }

  /* 兼容旧调用名 */
  const refreshPage = async () => { await refreshObjects(); };

  function rectOf(b) {
    const k = pxPerPt();
    return [b[0] * k, b[1] * k, (b[2] - b[0]) * k, (b[3] - b[1]) * k];
  }

  /* 拖动预览要把被拖对象那块像素从页面位图上抠下来，得先知道纸张底色，
     用来盖掉原位残留。取页面四角里最亮的那个，避开页眉横线与边缘阴影。 */
  let _paperCache = { key: '', color: '#ffffff' };
  function paperColor(im, ptW, ptH) {
    if (!im || !im.naturalWidth) return '#ffffff';
    const key = im.currentSrc || im.src;
    if (_paperCache.key === key) return _paperCache.color;
    let color = '#ffffff';
    try {
      const c = document.createElement('canvas');
      c.width = 1; c.height = 1;
      const t = c.getContext('2d', { willReadFrequently: true });
      const iw = im.naturalWidth;
      const ih = im.naturalHeight;
      let best = -1;
      [[3, 3], [ptW - 3, 3], [3, ptH - 3], [ptW - 3, ptH - 3]].forEach(([px, py]) => {
        t.clearRect(0, 0, 1, 1);
        t.drawImage(im, (px / ptW) * iw, (py / ptH) * ih, 1, 1, 0, 0, 1, 1);
        const d = t.getImageData(0, 0, 1, 1).data;
        const s = d[0] + d[1] + d[2];
        if (s > best) { best = s; color = `rgb(${d[0]},${d[1]},${d[2]})`; }
      });
    } catch (e) { /* 读不到就退回白色 */ }
    _paperCache = { key, color };
    return color;
  }

  /* 等页面位图换成新版本后再清实时层。不然松手瞬间会「弹回原位 → 跳到新位置」，
     中间还夹着一次后端往返，看着就是抖一下。 */
  async function settlePageImage() {
    const box = currentBox();
    const im = box && box.querySelector('img');
    if (!im || !im.decode) return;
    try {
      await Promise.race([
        im.decode(),
        new Promise((r) => setTimeout(r, 1500)),
      ]);
    } catch (e) { /* 解码失败就靠超时兜底 */ }
  }

  /* ---------------- 画布绘制：base 静态层 + live 实时层 ----------------
   * 分成两层的原因：拖动画笔时若每次都重绘"已提交的全部内容"，
   * 页面上笔画一多就会掉帧。实时操作只碰 live 层 —— 清一块、画一条线，
   * 开销和笔画总数无关，所以始终跟手。
   */
  const HANDLE_PT = 4.6;        // 手柄视觉半径（pt）
  const HANDLE_HIT_PT = 8;      // 手柄命中半径（pt），比视觉大一圈更好点
  const DIRS = [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]];
  const HANDLE_CURSOR = ['nwse-resize', 'ns-resize', 'nesw-resize', 'ew-resize',
    'nwse-resize', 'ns-resize', 'nesw-resize', 'ew-resize'];

  function canvasOf(box, cls) { return box ? box.querySelector('canvas.' + cls) : null; }

  function prepCtx(cvs) {
    if (!cvs) return null;
    // clientWidth/Height 是取整后的整数，而 .pbox 用的是小数 px。
    // 高 DPI（1.25 / 1.5 / 2）下这点差值会被 dpr 放大，画布内容相对
    // 位图轻微错位。用浮点 rect 量，位图和 CSS 尺寸才严格一一对应。
    const r = cvs.getBoundingClientRect();
    const w = r.width || cvs.clientWidth || 1;
    const h = r.height || cvs.clientHeight || 1;
    const dpr = window.devicePixelRatio || 1;
    const nw = Math.max(1, Math.round(w * dpr));
    const nh = Math.max(1, Math.round(h * dpr));
    if (cvs.width !== nw || cvs.height !== nh) { cvs.width = nw; cvs.height = nh; }
    const ctx = cvs.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return ctx;
  }

  /* 二次贝塞尔平滑：手写笔画不该出现明显折角 */
  function tracePath(ctx, pts, k) {
    if (!pts || !pts.length) return;
    if (pts.length === 1) {
      const r = Math.max(0.7, ctx.lineWidth / 2);
      ctx.beginPath();
      ctx.arc(pts[0][0] * k, pts[0][1] * k, r, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    ctx.beginPath();
    ctx.moveTo(pts[0][0] * k, pts[0][1] * k);
    if (pts.length === 2) {
      ctx.lineTo(pts[1][0] * k, pts[1][1] * k);
    } else {
      for (let i = 1; i < pts.length - 1; i++) {
        const ax = pts[i][0] * k, ay = pts[i][1] * k;
        const bx = ((pts[i][0] + pts[i + 1][0]) / 2) * k;
        const by = ((pts[i][1] + pts[i + 1][1]) / 2) * k;
        ctx.quadraticCurveTo(ax, ay, bx, by);
      }
      const n = pts.length - 1;
      ctx.lineTo(pts[n][0] * k, pts[n][1] * k);
    }
    ctx.stroke();
  }

  function bboxHandles(b) {
    const x0 = b[0], y0 = b[1], x1 = b[2], y1 = b[3];
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    return [[x0, y0], [cx, y0], [x1, y0], [x1, cy], [x1, y1], [cx, y1], [x0, y1], [x0, cy]];
  }

  function drawHandles(ctx, b, k) {
    const r = HANDLE_PT * k;
    ctx.setLineDash([]);
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = '#1f6feb';
    ctx.fillStyle = '#fff';
    bboxHandles(b).forEach(([x, y]) => {
      ctx.beginPath();
      ctx.rect(x * k - r, y * k - r, r * 2, r * 2);
      ctx.fill();
      ctx.stroke();
    });
  }

  /* base 层：内容都提交之后才需要重画 */
  function drawBase() {
    const box = currentBox();
    if (!box) return;
    const ctx = prepCtx(canvasOf(box, 'base'));
    if (!ctx) return;
    const k = pxPerPt();

    // 1) 文本块轮廓
    if (S.showText) {
      ctx.lineWidth = 0.8;
      ctx.strokeStyle = 'rgba(31,111,235,.35)';
      ctx.setLineDash([3, 3]);
      S.objs.texts.forEach((t) => {
        const [x, y, ww, hh] = rectOf(t.bbox);
        ctx.strokeRect(x, y, ww, hh);
      });
      ctx.setLineDash([]);
    }

    // 2) 已提交的笔迹
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    (S.objs.strokes || []).forEach((st) => {
      const pts = st.points || [];
      if (!pts.length) return;
      ctx.strokeStyle = st.color || '#d64545';
      ctx.fillStyle = ctx.strokeStyle;
      ctx.lineWidth = Math.max(0.6, (st.width || 2) * k);
      tracePath(ctx, pts, k);
    });

    // 3) 搜索命中
    S.hits.filter((hh) => hh.page === S.page).forEach((hh) => {
      const [x, y, ww, hh2] = rectOf(hh.bbox);
      ctx.fillStyle = 'rgba(255,196,0,.35)';
      ctx.fillRect(x, y, ww, hh2);
      ctx.strokeStyle = 'rgba(230,160,0,.9)';
      ctx.lineWidth = 1;
      ctx.strokeRect(x, y, ww, hh2);
    });

    // 4) 选中框与调整手柄（拖动期间交给 live 层画预览，base 不再参与，
    //    否则每帧都要重画全部笔画，拖动会掉帧）
    const sb = !S.drag && S.sel ? S.sel.bbox : null;
    if (sb) {
      const [x, y, ww, hh] = rectOf(sb);
      ctx.strokeStyle = '#1f6feb';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 3]);
      ctx.strokeRect(x - 0.5, y - 0.5, ww + 1, hh + 1);
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(31,111,235,.05)';
      ctx.fillRect(x, y, ww, hh);
      if (S.tool === 'select') drawHandles(ctx, sb, k);
    }
  }

  /* live 层：只在操作过程中重画，频率跟着 pointermove 走 */
  function drawLive() {
    const box = currentBox();
    if (!box) return;
    const ctx = prepCtx(canvasOf(box, 'live'));
    if (!ctx) return;
    const k = pxPerPt();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // 正在写的笔画
    if (S.drawing && S.drawing.points.length) {
      ctx.strokeStyle = S.drawing.color;
      ctx.fillStyle = S.drawing.color;
      ctx.lineWidth = Math.max(0.8, S.drawing.width * k);
      tracePath(ctx, S.drawing.points, k);
    }

    // 橡皮：擦过的范围 + 光标圈
    if (S.erasing && S.erasing.points.length) {
      const r = Math.max(1, S.erasing.radius);
      const pts = S.erasing.points;
      ctx.setLineDash([]);
      if (S.erasing.scope === 'all') {
        // 「擦内容」模式下轨迹本身就是要被涂掉的地方，画成纸色才符合直觉
        ctx.strokeStyle = 'rgba(255,255,255,.92)';
        ctx.fillStyle = 'rgba(255,255,255,.92)';
        ctx.lineWidth = r * 2 * k;
      } else {
        ctx.strokeStyle = 'rgba(214,69,69,.10)';
        ctx.fillStyle = 'rgba(214,69,69,.10)';
        ctx.lineWidth = Math.max(1, r * 2 * k);
      }
      tracePath(ctx, pts, k);
      if (pts.length === 1) {
        ctx.beginPath();
        ctx.arc(pts[0][0] * k, pts[0][1] * k, r * k, 0, Math.PI * 2);
        ctx.fill();
      }
      const last = pts[pts.length - 1];
      ctx.strokeStyle = 'rgba(214,69,69,.85)';
      ctx.fillStyle = 'rgba(255,255,255,.35)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(last[0] * k, last[1] * k, r * k, 0, Math.PI * 2);
      ctx.stroke();
    }

    // 橡皮悬停：没按下时也把橡皮圈画出来，不然不知道它到底有没有生效
    if (!S.erasing && S.tool === 'erase' && S.hoverPt) {
      const r = Math.max(1, S.eraser.radius);
      ctx.setLineDash([]);
      ctx.strokeStyle = 'rgba(214,69,69,.55)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(S.hoverPt[0] * k, S.hoverPt[1] * k, r * k, 0, Math.PI * 2);
      ctx.stroke();
    }

    // 拖出来的框
    if (S.dragSelect) {
      const d = S.dragSelect;
      const x = Math.min(d.a[0], d.b[0]) * k;
      const y = Math.min(d.a[1], d.b[1]) * k;
      const ww = Math.abs(d.b[0] - d.a[0]) * k;
      const hh = Math.abs(d.b[1] - d.a[1]) * k;
      ctx.strokeStyle = '#12805c';
      ctx.lineWidth = 1.4;
      ctx.setLineDash([5, 4]);
      ctx.strokeRect(x, y, ww, hh);
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(18,128,92,.08)';
      ctx.fillRect(x, y, ww, hh);
    }

    /* 移动 / 缩放的实时预览：把被拖对象那块像素从页面位图上抠下来，跟着指针走。
       只画一个空框的话，手感就是「框在动、内容没动」，松手再瞬移。 */
    if (S.drag && S.drag.cur) {
      const [x, y, ww, hh] = rectOf(S.drag.cur);
      const [ox, oy, ow, oh] = rectOf(S.drag.start);
      const im = box.querySelector('img');
      const [ptW, ptH] = sizeOf(S.page);
      if (im && im.naturalWidth && ww > 0 && hh > 0) {
        // 1) 先盖掉原位（用纸张底色，不然会看到两个一模一样的对象）
        ctx.fillStyle = paperColor(im, ptW, ptH);
        ctx.fillRect(ox - 1, oy - 1, ow + 2, oh + 2);
        // 2) 再把原像素画到新位置。源矩形用图片的自然像素坐标，
        //    这样不受 object-fit: contain 留白和 dpr 的影响
        const iw = im.naturalWidth;
        const ih = im.naturalHeight;
        const s = S.drag.start;
        try {
          ctx.drawImage(
            im,
            (s[0] / ptW) * iw, (s[1] / ptH) * ih,
            ((s[2] - s[0]) / ptW) * iw, ((s[3] - s[1]) / ptH) * ih,
            x, y, ww, hh,
          );
        } catch (e) { /* 源矩形偶尔越界，忽略这一帧 */ }
      }
      // 3) 细边框 + 手柄，别用半透明填充盖住内容
      ctx.setLineDash([]);
      ctx.strokeStyle = S.drag.kind === 'resize' ? '#7c3aed' : '#1f6feb';
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y + 0.5, Math.max(0, ww - 1), Math.max(0, hh - 1));
      if (S.tool === 'select') drawHandles(ctx, S.drag.cur, k);
    }
  }

  /* 合并到一帧里画，避免 pointermove 高频触发时重复重绘 */
  let paintQueued = 0;
  function paint(which = 'both') {
    if (paintQueued) {
      if (which === 'both') paintQueued = 2;   // 已有排队的实时重绘 → 升级成全量
      return;
    }
    paintQueued = which === 'both' ? 2 : 1;
    requestAnimationFrame(() => {
      const mode = paintQueued;
      paintQueued = 0;
      if (mode === 2) drawBase();
      drawLive();
    });
  }

  function drawOverlay() {
    drawBase();
    drawLive();
  }

  /* ------------------------------------------------------------------ 对象列表 */
  function renderObjList() {
    const box = $('#objlist');
    const rows = [];
    S.objs.texts.forEach((t) => {
      const tag = t.source === 'ocr' ? 'ocr' : t.source === 'user' ? 'mine' : 'text';
      rows.push({
        cls: t.source === 'ocr' ? 'ocr' : t.source === 'user' ? 'user' : '',
        tag,
        title: t.text,
        meta: `${Math.round(t.bbox[0])},${Math.round(t.bbox[1])}  ·  ${(t.size || 0).toFixed(1)}pt` +
          (t.score != null ? `  ·  conf ${(t.score * 100).toFixed(0)}%` : ''),
        obj: { kind: 'text', ...t },
      });
    });
    S.objs.images.forEach((im) => {
      rows.push({
        cls: '',
        tag: im.source === 'user' ? 'mine-img' : 'img',
        title: im.name ? `${im.name}` : `图片 ${im.pixel_width || ''}×${im.pixel_height || ''}`,
        meta: `${Math.round(im.bbox[0])},${Math.round(im.bbox[1])} → ${Math.round(im.bbox[2])},${Math.round(im.bbox[3])}`,
        obj: { kind: 'image', ...im },
      });
    });
    S.objs.strokes.forEach((st) => {
      rows.push({
        cls: '',
        tag: 'ink',
        title: `笔迹 ${st.points.length} 点`,
        meta: `宽度 ${st.width}  ·  ${st.id}`,
        obj: { kind: 'stroke', ...st },
      });
    });

    box.innerHTML = '';
    if (ocrStale()) {
      // 只提示，不替用户改开关：想用就点刷新，不想看就收起
      const tip = document.createElement('div');
      tip.className = 'ocr-tip';
      tip.innerHTML = `<span>这一页改过内容，下面的识别框可能偏了</span>
        <div class="ocr-tip-btns">
          <button class="mini" id="tip-ocr-refresh">刷新识别</button>
          <button class="mini ghost" id="tip-ocr-off">收起</button>
        </div>`;
      box.appendChild(tip);
      tip.querySelector('#tip-ocr-refresh').onclick = () => doOcrPage({ force: true });
      tip.querySelector('#tip-ocr-off').onclick = () => closeOcrPage();
    }
    if (!rows.length) {
      box.insertAdjacentHTML('beforeend', '<div class="empty-list">本页没有可编辑对象</div>');
      return;
    }
    rows.forEach((r) => {
      const el = document.createElement('div');
      el.className = 'obj' + (S.sel && S.sel.id === r.obj.id && S.sel.kind === r.obj.kind ? ' sel' : '');
      el.innerHTML = `<div class="row1"><span class="tag ${r.cls}">${r.tag}</span></div>
        <div class="txt">${esc(r.title)}</div><div class="meta">${esc(r.meta)}</div>`;
      el.onclick = () => {
        S.sel = r.obj;
        drawOverlay();
        renderObjList();
        renderProps();
        showTab('props');
      };
      box.appendChild(el);
    });
  }

  /* ------------------------------------------------------------------ 属性面板 */
  function renderProps() {
    const box = $('#props');
    if (!S.sel) {
      box.innerHTML = `<div class="hint">用「选择」工具点击页面上的文字、图片或笔迹，或从右侧对象列表里选一个。</div>`;
      return;
    }
    const o = S.sel;
    if (o.kind === 'text') {
      const color = Array.isArray(o.color)
        ? '#' + o.color.map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('')
        : '#111111';
      const locked = ocrLocked(o);
      box.innerHTML = `
        <div class="field"><label>文本内容</label>
          <textarea data-f="text" id="p-text">${esc(o.text)}</textarea></div>
        <div class="field row">
          <div><label>字号</label><input type="number" id="p-size" step="0.5" min="4" max="120" value="${o.size || 12}" /></div>
          <div><label>来源</label><input type="text" value="${{ text: '文本层', ocr: 'OCR 识别', user: '我插入的' }[o.source] || o.source}" readonly /></div>
        </div>
        <div class="field"><label>颜色</label>
          <div class="color-row"><input type="color" id="p-color" value="${color}" /><input type="text" id="p-color-hex" value="${color}" /></div>
        </div>
        <div class="hint${locked ? ' warn' : ''}" id="p-hint"></div>
        <div class="actions">
          <button class="btn primary" id="p-apply"${locked ? ' disabled' : ''}>应用修改</button>
          <button class="btn danger" id="p-del"${locked ? ' disabled' : ''}>删除</button>
        </div>`;
      const hex = $('#p-color-hex');
      $('#p-color').oninput = (e) => (hex.value = e.target.value);
      hex.oninput = (e) => { if (/^#[0-9a-f]{6}$/i.test(e.target.value)) $('#p-color').value = e.target.value; };
      $('#p-hint').textContent = locked
        ? '这一页内容改过，这一行 OCR 的框是按旧位图算的；先点「刷新识别」重算，再改它。'
        : (o.source === 'ocr'
          ? 'OCR 文字没有真正的文字层，修改时会用页面底色覆盖原位置后重绘。'
          : '会先抹掉原文字（保留图像），再按原样式重绘。') + ' 在画布上拖动可移动，拖四角可缩放（字号联动）。';
      $('#p-apply').onclick = () => applyTextEdit(o);
      $('#p-del').onclick = () => deleteText(o);
    } else if (o.kind === 'image') {
      box.innerHTML = `
        <div class="field"><label>位置</label><input type="text" readonly value="${o.bbox.map((v) => Math.round(v)).join(', ')}" /></div>
        <div class="field"><label>尺寸</label><input type="text" readonly value="${Math.round(o.bbox[2] - o.bbox[0])} × ${Math.round(o.bbox[3] - o.bbox[1])} pt" /></div>
        <div class="field"><label>来源</label><input type="text" readonly value="${o.source === 'user' ? '我插入的' : 'PDF 原有'}" /></div>
        <div class="hint">在画布上拖动可移动；拖四角等比缩放，拖四边单向拉伸。</div>
        <div class="actions">
          <button class="btn" id="p-replace">替换图片</button>
          <button class="btn danger" id="p-del">删除</button>
        </div>`;
      $('#p-replace').onclick = () => replaceImage(o);
      $('#p-del').onclick = () => deleteImage(o);
    } else {
      box.innerHTML = `
        <div class="field"><label>笔迹</label><input type="text" readonly value="${o.points.length} 个点，宽度 ${o.width}" /></div>
        <div class="hint">笔迹以 Ink 注释保存，可随时擦除；保存时可"烘焙"成矢量图形。</div>
        <div class="actions"><button class="btn danger" id="p-del">擦除这条</button></div>`;
      $('#p-del').onclick = async () => {
        try {
          await api('/api/ink/erase', {
            json: { page: S.page, bbox: bboxOfPoints(o.points), radius: 0.1, mode: 'stroke' },
          });
          S.sel = null;
          await afterContentChange();
          toast('已擦除', 'ok');
        } catch (e) { toast(e.message, 'err'); }
      };
    }
  }

  function bboxOfPoints(pts) {
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  }

  /* 内容变了：刷新对象 + 缩略图，页面位图按需更新。
     顺序很关键 —— 先把新位图的请求发出去（URL 里的 rev 已由写接口的响应更新），
     再等对象列表回来。反过来做的话，位图要等 JSON 往返完才开始下载，
     一次拖动提交就白等一个来回。 */
  /* 内容改了：这一页的识别框是按旧位图算的，位置可能对不上。
     但"开不开 OCR"是用户的开关 —— 不替他关，也不自动重跑（整页 1~3 秒）。
     只打一个"待刷新"标记，用户点「刷新识别」才重算，点「收起识别」才关掉。 */
  function markOcrStale(page = S.page) {
    if (!S.ocrPages.has(page) || S.ocrStale.has(page)) return;
    S.ocrStale.add(page);
    if (page === S.page) {
      syncOcrButton();
      renderObjList();
      toast('这一页内容改过了，识别框可能偏了；点「刷新识别」重算，或「收起识别」关掉', '');
    }
  }

  async function afterContentChange(opts = {}) {
    // 写操作期间可能已经翻页；改动属于哪一页要锁死，别把当前页误标成 OCR 过期、误刷缩略图
    const { pageImage = true, page = S.page } = opts;
    markOcrStale(page);
    reloadThumb(page);
    if (pageImage) reloadPageImage(page);
    requestAnimationFrame(renderDocList);
    await refreshObjects();
  }

  async function applyTextEdit(o) {
    if (ocrLocked(o)) return warnOcrLocked();
    const text = $('#p-text').value;
    if (!text.trim()) return toast('内容不能为空', 'err');
    const size = parseFloat($('#p-size').value) || (o.size || 12);
    const color = $('#p-color').value;
    try {
      await api('/api/text', { method: 'PUT', json: { page: S.page, id: o.id, text, font_size: size, color } });
      S.sel = null;
      await afterContentChange();
      toast('已更新', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  }

  async function deleteText(o) {
    if (ocrLocked(o)) return warnOcrLocked();
    try {
      await api('/api/text', { method: 'DELETE', json: { page: S.page, id: o.id } });
      S.sel = null;
      await afterContentChange();
      toast('已删除', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  }

  async function replaceImage(o) {
    const f = await pickFile('image');
    if (!f) return;
    const dataUrl = await fileToDataURL(f);
    try {
      await api('/api/image', { method: 'PUT', json: { page: S.page, id: o.id, data_url: dataUrl } });
      S.sel = null;
      await afterContentChange();
      toast('已替换', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  }

  async function deleteImage(o) {
    try {
      // 显式要 purge：真删。不写依赖服务端默认值 —— 默认值一旦回退成 cover，
      // 图只是被盖住，保存后原图仍在文件里，同一位置再插图也容易认错旧实例。
      await api('/api/image', { method: 'DELETE', json: { page: S.page, id: o.id, mode: 'purge' } });
      S.sel = null;
      await afterContentChange();
      toast('已删除图片', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  }

  /* 删：笔迹。list_strokes 不给 bbox，按点自行算，再让后端整条删掉。 */
  async function deleteStroke(o) {
    const pts = o.points || [];
    if (!pts.length) return false;
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const pad = Math.max(1.5, (o.width || 2) / 2 + 1);
    const bbox = [
      Math.min(...xs) - pad, Math.min(...ys) - pad,
      Math.max(...xs) + pad, Math.max(...ys) + pad,
    ];
    try {
      await api('/api/ink/erase', { json: { page: S.page, bbox, mode: 'stroke' } });
      S.sel = null;
      await afterContentChange();
      toast('已删除笔迹', 'ok');
    } catch (e) { toast(e.message, 'err'); }
    return true;
  }

  /* 删除选中对象。Delete / Backspace 共用；返回 false 表示这次按键不该被吞掉 */
  function deleteSelection(sel) {
    if (!sel) return false;
    if (sel.kind === 'text') { deleteText(sel); return true; }
    if (sel.kind === 'image') { deleteImage(sel); return true; }
    if (sel.kind === 'stroke') { deleteStroke(sel); return true; }
    return false;
  }

  /* ------------------------------------------------------------------ 画布交互 */
  /* pointerdown 时缓存一次几何：pointermove 里每帧都调 getBoundingClientRect()
     会强制浏览器同步布局，是画笔"一卡一卡"的典型原因。
     但缓存也不能一直用 —— 手势中间滚动、缩放、侧栏展开都会让 rect 失效，
     继续拿旧 rect 换算，后面每一个点都整体平移，看上去就是"笔画跳到别处"。
     所以缓存里同时记下滚动位置 / zoom / 页面上下文，变了就校正或重测。 */
  let baseRect = null;

  function measureBase(box) {
    const b = box || currentBox();
    if (!b) { baseRect = null; return; }
    const r = b.getBoundingClientRect();
    const pi = Number.isInteger(+b.dataset.page) ? +b.dataset.page : S.page;
    const [w, h] = sizeOf(pi);
    baseRect = {
      box: b,
      left: r.left, top: r.top,
      // 用实测比例，不用理论 zoom：位图被拉到 100% 铺满 box，
      // box 的实际宽高才决定每 pt 对应多少 CSS px
      sx: r.width > 0 && w > 0 ? r.width / w : layoutScale(),
      sy: r.height > 0 && h > 0 ? r.height / h : layoutScale(),
      sl: wrap.scrollLeft, st: wrap.scrollTop,
      zoom: S.zoom, doc: S.doc, page: S.page, seq: S.ctxSeq,
    };
  }

  function toPdf(ev, box) {
    const b = box || currentBox();
    if (!b) return [0, 0];
    let m = baseRect;
    if (!m || m.box !== b || !m.box.isConnected || m.zoom !== S.zoom
        || m.doc !== S.doc || m.page !== S.page || m.seq !== S.ctxSeq) {
      measureBase(b);
      m = baseRect;
    } else if (m.sl !== wrap.scrollLeft || m.st !== wrap.scrollTop) {
      // 滚动只平移 rect，不改变宽高比例：按增量修正，不重新触发布局
      m.left -= wrap.scrollLeft - m.sl;
      m.top -= wrap.scrollTop - m.st;
      m.sl = wrap.scrollLeft;
      m.st = wrap.scrollTop;
    }
    if (!m) return [0, 0];
    return [(ev.clientX - m.left) / m.sx, (ev.clientY - m.top) / m.sy];
  }

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  /* 限制在页面范围内，尺寸不变（只挪位置），避免拖动时对象被压变形 */
  function clampBbox(b) {
    const [pw, ph] = sizeOf(S.page);
    const w = Math.min(Math.max(2, b[2] - b[0]), pw);
    const h = Math.min(Math.max(2, b[3] - b[1]), ph);
    const x = clamp(b[0], 0, pw - w);
    const y = clamp(b[1], 0, ph - h);
    return [x, y, x + w, y + h];
  }

  function inBbox(pt, b) {
    return !!b && pt[0] >= b[0] && pt[0] <= b[2] && pt[1] >= b[1] && pt[1] <= b[3];
  }

  /* 命中手柄：返回方向索引 0..7，没点到返回 null。
     取"距离最近"而不是"第一个命中"——对象很矮时角手柄和边手柄的
     命中范围会重叠，按顺序取会让拖角变成拖边。 */
  function hitHandle(pt, b) {
    if (!b) return null;
    const pts = bboxHandles(b);
    let best = null;
    let bestD = Infinity;
    pts.forEach((p, i) => {
      const d = Math.hypot(p[0] - pt[0], p[1] - pt[1]);
      if (d <= HANDLE_HIT_PT && d < bestD) { best = i; bestD = d; }
    });
    return best;
  }

  /* 命中测试：按「视觉层叠顺序」从上往下找。
     用户插入的图片/文本压在 PDF 原有内容之上；如果按面积取最小，
     点到图片中心时会选中它底下那行小字 —— 表现就是「图片拖不动」。 */
  function hitTest(pt) {
    // 1) 笔迹在最上层：命中范围只有 5pt，点到就算
    for (const st of (S.objs.strokes || [])) {
      for (const p of st.points || []) {
        if (Math.abs(p[0] - pt[0]) < 5 && Math.abs(p[1] - pt[1]) < 5) return { kind: 'stroke', ...st };
      }
    }
    // 2) 文本与图片一起排序：用户插入的优先；同一层里比面积（小的更精确）
    const cands = [];
    (S.objs.texts || []).forEach((t) => {
      if (inBbox(pt, t.bbox)) cands.push({ kind: 'text', ...t });
    });
    (S.objs.images || []).forEach((im) => {
      if (inBbox(pt, im.bbox)) cands.push({ kind: 'image', ...im });
    });
    if (!cands.length) return null;
    if (cands.length > 1) {
      const area = (o) => Math.max(1, (o.bbox[2] - o.bbox[0]) * (o.bbox[3] - o.bbox[1]));
      cands.sort((a, b) => {
        const ua = a.source === 'user' ? 1 : 0;
        const ub = b.source === 'user' ? 1 : 0;
        if (ua !== ub) return ub - ua;
        return area(a) - area(b);
      });
    }
    return cands[0];
  }

  /* 视口中心对应的页面坐标：插入的图片/文本落在你正在看的地方，而不是页面正中 */
  function viewCenterPt() {
    const box = currentBox();
    const size = sizeOf(S.page);
    if (!box) return [size[0] / 2, size[1] / 2];
    const br = box.getBoundingClientRect();
    const wr = wrap.getBoundingClientRect();
    const cx = clamp(wr.left + wr.width / 2 - br.left, 0, br.width);
    const cy = clamp(wr.top + wr.height / 2 - br.top, 0, br.height);
    const sx = br.width > 0 ? br.width / size[0] : pxPerPt();
    const sy = br.height > 0 ? br.height / size[1] : pxPerPt();
    return [cx / sx, cy / sy];
  }

  /* 采样：距离太近的点丢掉，既不抖也不浪费 */
  function appendPoint(list, pt, minDist) {
    const last = list[list.length - 1];
    if (!last || Math.hypot(pt[0] - last[0], pt[1] - last[1]) >= minDist) list.push(pt);
  }

  /* 橡皮的本地即时擦除：按"点到线段距离"把笔画切开，
     手指经过时就能看到线断开，不用等服务端往返 */
  function segDist(p, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    if (len2 < 1e-9) return Math.hypot(p[0] - a[0], p[1] - a[1]);
    let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
  }

  function eraseLocal(points, radius) {
    let changed = false;
    const next = [];
    (S.objs.strokes || []).forEach((st) => {
      const pts = st.points || [];
      if (pts.length < 2) { next.push(st); return; }
      const segs = [];
      let cur = [];
      let hitAny = false;
      for (let i = 0; i < pts.length; i++) {
        if (i > 0) {
          const hit = points.some((q) => segDist(q, pts[i - 1], pts[i]) <= radius);
          if (hit) {
            hitAny = true;
            if (cur.length >= 2) segs.push(cur);
            cur = [];
            continue;
          }
        }
        cur.push(pts[i]);
      }
      if (cur.length >= 2) segs.push(cur);
      if (!hitAny) { next.push(st); return; }
      changed = true;
      segs.forEach((seg) => next.push({ ...st, id: st.id, points: seg }));
    });
    if (changed) S.objs.strokes = next;
    return changed;
  }

  /* ------------------------------------------------------------------ 指针事件 */
  pagesBox.addEventListener('pointerdown', async (ev) => {
    if (!S.doc || S.busy) return;
    const box = ev.target.closest('.pbox');
    if (!box) return;
    const idx = +box.dataset.page;
    // 连续/横向模式下点到别的页：先切过去，不误画
    if (idx !== S.page) {
      await setCurrentPage(idx, { scroll: false });
      return;
    }
    measureBase(box);
    try { ev.target.setPointerCapture?.(ev.pointerId); } catch (e) { /* 合成事件没有真实 pointerId */ }
    const pt = toPdf(ev, box);

    if (S.tool === 'select') {
      // 1) 手柄优先：选中状态下四角四边都能拖
      const hIdx = hitHandle(pt, S.sel && S.sel.bbox);
      if (hIdx != null) {
        if (ocrLocked(S.sel)) { warnOcrLocked(); return; }
        S.drag = {
          kind: 'resize', dir: DIRS[hIdx], obj: S.sel, start: S.sel.bbox.slice(),
          cur: S.sel.bbox.slice(), anchor: pt, size: S.sel.size || null,
          keep: S.sel.kind === 'image', moved: false,
        };
        paint('both');
        return;
      }
      // 2) 点到对象：选中并准备拖动
      const hit = hitTest(pt);
      if (hit) {
        S.sel = hit;
        // 笔迹只支持选中后删除，没有"拖动"这回事——给它建 drag 会让松手时
        // 拿笔迹 id 去调 /api/image，白报一个错
        if (hit.kind !== 'stroke') {
          if (ocrLocked(hit)) {
            // 框是旧位图算的，拿它去 redact 会抹错位置。让选中照常生效，
            // 但先拦住拖动，提示用户刷新识别。
            warnOcrLocked();
            renderObjList();
            renderProps();
            showTab('props');
            paint('both');
            return;
          }
          S.drag = {
            kind: 'move', dir: [0, 0], obj: hit, start: hit.bbox.slice(),
            cur: hit.bbox.slice(), anchor: pt, size: hit.size || null,
            keep: hit.kind === 'image', moved: false,
          };
        }
        renderObjList();
        renderProps();
        showTab('props');
        paint('both');
        return;
      }
      // 3) 点空白：取消选中
      S.sel = null;
      S.drag = null;
      renderObjList();
      renderProps();
      paint('both');
      return;
    }

    if (S.tool === 'draw') {
      S.drawing = { points: [pt], color: S.brush.color, width: S.brush.width };
      paint('live');
      return;
    }

    if (S.tool === 'erase') {
      S.erasing = { points: [pt], radius: S.eraser.radius };
      paint('live');
      return;
    }

    if (S.tool === 'text') {
      S.dragSelect = { a: pt, b: pt, kind: 'text' };
      paint('live');
      return;
    }

    if (S.tool === 'pan') {
      S.pan = { x: ev.clientX, y: ev.clientY, l: wrap.scrollLeft, t: wrap.scrollTop };
    }
  });

  pagesBox.addEventListener('pointermove', (ev) => {
    if (!S.doc) return;

    // 选中对象后，悬停四角四边给出对应的缩放光标（这是"能不能拉"的直觉来源）
    if (S.tool === 'select' && !S.drag && S.sel && S.sel.kind !== 'stroke' && S.sel.bbox) {
      const b = ev.target.closest('.pbox');
      if (b && +b.dataset.page === S.page) {
        const hi = hitHandle(toPdf(ev, b), S.sel.bbox);
        b.style.cursor = hi == null ? 'default' : HANDLE_CURSOR[hi];
      }
    }

    if (S.drawing) {
      // 用合并事件拿到高频采样点，高刷屏上手写更圆滑
      const list = (ev.getCoalescedEvents && ev.getCoalescedEvents().length) ? ev.getCoalescedEvents() : [ev];
      list.forEach((e) => appendPoint(S.drawing.points, toPdf(e), 0.35));
      paint('live');
      return;
    }

    if (S.erasing) {
      const pt = toPdf(ev);
      const last = S.erasing.points[S.erasing.points.length - 1];
      if (Math.hypot(pt[0] - last[0], pt[1] - last[1]) >= 1) {
        const prev = last;
        S.erasing.points.push(pt);
        // 本地先把挥过的笔迹切开，页面原有内容等服务端擦完再刷新位图
        const cut = eraseLocal([prev, pt], S.erasing.radius);
        paint(cut ? 'both' : 'live');
      }
      return;
    }

    // 橡皮悬停圈：让"橡皮到底生效了没有"一眼可见
    if (S.tool === 'erase') {
      const b = ev.target.closest && ev.target.closest('.pbox');
      if (b && +b.dataset.page === S.page) {
        S.hoverPt = toPdf(ev, b);
        paint('live');
      }
    }

    if (S.dragSelect) {
      S.dragSelect.b = toPdf(ev);
      paint('live');
      return;
    }

    if (S.drag) {
      const pt = toPdf(ev);
      const d = S.drag;
      const [x0, y0, x1, y1] = d.start;
      if (d.kind === 'move') {
        const dx = pt[0] - d.anchor[0];
        const dy = pt[1] - d.anchor[1];
        if (Math.abs(dx) > 0.3 || Math.abs(dy) > 0.3) d.moved = true;
        d.cur = clampBbox([x0 + dx, y0 + dy, x1 + dx, y1 + dy]);
      } else {
        let a = x0, b = y0, c = x1, e = y1;
        const [ux, uy] = d.dir;
        if (ux < 0) a = Math.min(pt[0], x1 - 6);
        if (ux > 0) c = Math.max(pt[0], x0 + 6);
        if (uy < 0) b = Math.min(pt[1], y1 - 6);
        if (uy > 0) e = Math.max(pt[1], y0 + 6);
        if (ux !== 0 && uy !== 0 && d.keep) {
          // 角手柄等比缩放，以被拖动的对角为锚点
          const ratio = (x1 - x0) / Math.max(1e-6, y1 - y0);
          let w = c - a, h = e - b;
          if (w / h > ratio) w = h * ratio; else h = w / ratio;
          if (ux < 0) a = c - w; else c = a + w;
          if (uy < 0) b = e - h; else e = b + h;
        }
        const nb = clampBbox([a, b, c, e]);
        d.cur = nb;
        d.moved = true;
        if (d.obj && d.obj.kind === 'text' && d.size) {
          d.fontSize = clamp(d.size * ((nb[3] - nb[1]) / Math.max(1e-6, y1 - y0)), 4, 200);
        }
      }
      paint('live');
      return;
    }

    if (S.pan) {
      wrap.scrollLeft = S.pan.l - (ev.clientX - S.pan.x);
      wrap.scrollTop = S.pan.t - (ev.clientY - S.pan.y);
    }
  });

  pagesBox.addEventListener('pointerleave', () => {
    if (S.hoverPt) { S.hoverPt = null; paint('live'); }
  });

  /* 指针手势收尾：up 和 cancel 走同一套逻辑。
     触摸屏/手写笔上如果浏览器把手势判成滚动，会直接发 pointercancel，
     不收拾的话这一笔既不会落库、状态还会一直悬着。 */
  async function endGesture(ev) {
    if (!S.doc) return;
    /* 这一笔/这次拖动属于哪一页，松手时就锁死。中间两个 await 之间用户
       完全可能翻页或滚动到别页，旧代码在这时才去读 S.page，于是笔画
       落到 A 页、对象列表却拉 B 页，或把 A 页的框贴到 B 页上。 */
    const ctx = ctxNow();
    baseRect = null;

    if (S.pan) { S.pan = null; return; }

    if (S.drawing) {
      const d = S.drawing;
      S.drawing = null;
      if (!d.points.length) { paint('live'); return; }
      // 乐观更新：先把这一笔放进本地，画面立刻定住，再异步落库。
      // 这样松手不会有"线消失一下再出现"的闪烁。
      const tmp = { id: 'tmp' + Date.now(), points: d.points, color: d.color, width: d.width, source: 'user' };
      S.objs.strokes.push(tmp);
      paint('both');
      try {
        await api('/api/ink', { json: { page: ctx.page, strokes: [{ points: d.points, color: d.color, width: d.width }] } });
        reloadThumb(ctx.page);
        // 已经翻到别页：数据落库了，别再拿旧页对象去覆盖新页的 S.objs
        if (!ctxSame(ctx)) return;
        markOcrStale();
        // 把这一页的 OCR 行存进缓存，refreshObjects 才能原样带回来
        const keepOcr = (S.objs.texts || []).filter((t) => t.source === 'ocr');
        if (keepOcr.length) S.ocrCache.set(ctx.page, keepOcr);
        await refreshObjects();
      } catch (e) {
        if (ctxSame(ctx)) S.objs.strokes = S.objs.strokes.filter((x) => x.id !== tmp.id);
        paint('both');
        toast(e.message, 'err');
      }
      return;
    }

    if (S.erasing) {
      const e0 = S.erasing;
      S.erasing = null;
      paint('both');
      try {
        // 橡皮只切笔迹：走 ink/erase 的 cut 模式，不调 /api/erase。
        // 后者会命中页面原有文字（redaction 真删，撤销之外无法恢复），
        // 在编辑正式文档时太容易误伤。
        let cut = { removed: 0 };
        if ((S.objs.strokes || []).length) {
          cut = await api('/api/ink/erase', {
            json: { page: ctx.page, points: e0.points, radius: e0.radius, mode: 'cut' },
          });
        }
        if (!ctxSame(ctx)) return;
        await afterContentChange();
        toast(cut.removed ? `已擦除笔迹 ${cut.removed} 处` : '这里没有可擦除的笔迹',
          cut.removed ? 'ok' : '');
      } catch (e) {
        toast(e.message, 'err');
        drawOverlay();
      }
      return;
    }

    if (S.dragSelect) {
      const d = S.dragSelect;
      S.dragSelect = null;
      let rect = [Math.min(d.a[0], d.b[0]), Math.min(d.a[1], d.b[1]), Math.max(d.a[0], d.b[0]), Math.max(d.a[1], d.b[1])];
      paint('live');
      // 只是点了一下（没拖出框）：在点击处放一个默认大小的文本框
      if (rect[2] - rect[0] < 8 || rect[3] - rect[1] < 8) rect = defaultTextBox(d.a);
      await placeText(rect, ctx);
      return;
    }

    if (S.drag) {
      const d = S.drag;
      if (d.moved) {
        // 故意不清 S.drag：预览要一直停在松手的位置，等新位图就绪由 commitDrag 收尾
        await commitDrag(d, ctx);
      } else {
        S.drag = null;
        paint('both');
      }
    }
  }

  pagesBox.addEventListener('pointerup', endGesture);
  pagesBox.addEventListener('pointercancel', endGesture);

  function defaultTextBox(pt) {
    const [pw] = sizeOf(S.page);
    const w = clamp(pw * 0.34, 120, 260);
    const h = Math.max(18, S.textStyle.size * 1.8);
    return clampBbox([pt[0], pt[1], pt[0] + w, pt[1] + h]);
  }

  /* 增：文本框 */
  async function placeText(rect, ctx = null) {
    const c = ctx || ctxNow();
    const text = await askText('', '输入要插入的文字');
    if (!text || !text.trim()) return;
    try {
      // rect 是按落笔那一页的坐标系算出来的，page 必须用同一页；
      // 弹窗输入期间翻了页还读 S.page，文字就会出现在别页的错误位置。
      const rec = await api('/api/text', {
        json: { page: c.page, text, rect, font_size: S.textStyle.size, color: S.textStyle.color },
      });
      if (!ctxSame(c)) { setTool('select'); return; }
      await afterContentChange();
      if (rec) {
        S.sel = { kind: 'text', ...rec, source: 'user', size: S.textStyle.size };
        renderObjList();
        renderProps();
        showTab('props');
      }
      setTool('select');
      toast('已插入文本框，拖动可移动，拖四角可缩放', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  }

  /* 增：图片 —— 选完直接按原比例插入到视口中心，然后拖手柄调整大小 */
  function imageSizeOf(dataUrl) {
    return new Promise((resolve) => {
      const im = new Image();
      im.onload = () => resolve({ w: im.naturalWidth || 320, h: im.naturalHeight || 240 });
      im.onerror = () => resolve({ w: 320, h: 240 });
      im.src = dataUrl;
    });
  }

  /* 统一的「把一张图插进当前页」入口：文件选择、Ctrl+V 粘贴都走这里。
     插入位置是当前视口中心，按原比例、最大占页宽 55% / 页高 60%。 */
  async function insertImageData(dataUrl, name) {
    if (!S.doc) { toast('先打开或新建一个文档', 'err'); return null; }
    const ctx = ctxNow();
    const dim = await imageSizeOf(dataUrl);
    // 等图片解码期间翻了页，就不要按新页的视口中心算坐标了
    if (!ctxSame(ctx)) { toast('页面已切换，请重新插入图片', ''); return null; }
    const [pw, ph] = sizeOf(ctx.page);
    // 像素按 96dpi 换成 pt，太大就缩到页面宽度的 55%
    let w = Math.min((dim.w * 72) / 96, pw * 0.55);
    let h = w * (dim.h / Math.max(1, dim.w));
    if (h > ph * 0.6) { h = ph * 0.6; w = h * (dim.w / Math.max(1, dim.h)); }
    const center = viewCenterPt();
    const rect = clampBbox([center[0] - w / 2, center[1] - h / 2, center[0] + w / 2, center[1] + h / 2]);
    try {
      const rec = await api('/api/image', {
        json: { page: ctx.page, rect, data_url: dataUrl, name },
      });
      if (!ctxSame(ctx)) { setTool('select'); return rec; }
      await afterContentChange();
      if (rec) {
        S.sel = { kind: 'image', ...rec, source: 'user' };
        renderObjList();
        renderProps();
        showTab('props');
      }
      setTool('select');
      return rec;
    } catch (e) {
      toast(e.message, 'err');
      return null;
    }
  }

  async function insertImageNow() {
    const f = await pickFile('image');
    if (!f) return;
    const data = await fileToDataURL(f);
    const rec = await insertImageData(data, f.name);
    if (rec) toast('图片已插入，拖四周手柄可调整大小', 'ok');
  }

  /* 移动 / 缩放的提交：松手才落库，过程中只在画布上预览。
     预览一直保留到新位图就绪（settlePageImage），避免松手瞬间弹回原位。 */
  async function commitDrag(d, ctx = null) {
    const c = ctx || ctxNow();
    const o = d.obj;
    if (!o) { S.drag = null; paint('both'); return; }
    // 只有文本和图片支持变换，别的类型直接放弃预览
    if (o.kind !== 'text' && o.kind !== 'image') { S.drag = null; paint('both'); return; }
    const rect = d.cur;
    if (d.kind === 'move'
      && Math.abs(rect[0] - d.start[0]) < 0.4
      && Math.abs(rect[1] - d.start[1]) < 0.4) {
      S.drag = null;
      paint('both');
      return;
    }
    try {
      let res;
      if (o.kind === 'text') {
        res = await api('/api/text', {
          method: 'PUT',
          json: {
            page: c.page, id: o.id, rect,
            font_size: d.kind === 'resize' ? d.fontSize : (o.size || undefined),
          },
        });
      } else {
        res = await api('/api/image', {
          method: 'PUT',
          json: { page: c.page, id: o.id, rect, keep_ratio: d.kind === 'resize' ? d.keep : true },
        });
      }
      await afterContentChange({ page: c.page });
      // 中途翻了页：下面要拿 S.objs（已经是新页的）去重新定位旧页对象，
      // 会把新页某个不相干的对象选中。直接收起预览即可。
      if (!ctxSame(c)) { S.drag = null; paint('both'); return; }
      // 变换后 id 可能变（原生文本按坐标编号），用"内容 + 中心点最近"重新定位选中项，
      // 这样连续拖两次手柄不会因为丢选中而变成拖动
      const items = o.kind === 'text' ? S.objs.texts : S.objs.images;
      const nb = (res && res.bbox) || rect;
      const cx = (nb[0] + nb[2]) / 2, cy = (nb[1] + nb[3]) / 2;
      let pool = items;
      if (o.kind === 'text' && o.text) {
        const same = items.filter((x) => (x.text || '') === o.text);
        if (same.length) pool = same;
      }
      let near = null;
      let best = Infinity;
      pool.forEach((x) => {
        const b = x.bbox;
        const d = Math.hypot((b[0] + b[2]) / 2 - cx, (b[1] + b[3]) / 2 - cy);
        if (d < best) { best = d; near = x; }
      });
      S.sel = near && best < 60 ? { kind: o.kind, ...near } : null;
      // 预览留在新位置，等页面位图换成新版再收起 —— 中间这段用户看不到任何跳变
      await settlePageImage();
      S.drag = null;
      paint('both');
      renderObjList();
      renderProps();
      toast(d.kind === 'move' ? '已移动' : '已调整大小', 'ok');
    } catch (e) {
      toast(e.message, 'err');
      await afterContentChange({ page: c.page });
      await settlePageImage();
      S.drag = null;
      paint('both');
    }
  }

  /* ------------------------------------------------------------------ 工具切换 */
  function setTool(t) {
    // 「图片」是个动作而不是一种模式：点一下就选文件、立刻插入，
    // 不再要求先拖框（拖框那套已经去掉了）。
    if (t === 'image') {
      if (!S.doc) { toast('先打开或新建一个文档', 'err'); return; }
      insertImageNow();
      return;
    }
    S.tool = t;
    S.hoverPt = null;
    $$('#tools .tool').forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
    syncStageClass();
    S.pendingImage = null;
    renderFloatbar();
    drawOverlay();
  }

  function renderFloatbar() {
    const bar = $('#floatbar');
    if (S.tool === 'draw') {
      bar.innerHTML = `<span>颜色</span><input type="color" id="ink-color" value="${S.brush.color}" />
        <span>粗细</span><input type="range" id="ink-width" min="0.5" max="12" step="0.5" value="${S.brush.width}" />
        <span class="val" id="ink-width-val">${S.brush.width}</span>
        <span class="hint" style="margin:0">按住拖动书写，松手即时落笔</span>`;
      $('#ink-color').oninput = (e) => (S.brush.color = e.target.value);
      $('#ink-width').oninput = (e) => {
        S.brush.width = parseFloat(e.target.value);
        $('#ink-width-val').textContent = S.brush.width;
      };
    } else if (S.tool === 'erase') {
      // 只有笔迹可擦。曾经提供「笔迹 + 页面内容」的选项，结果很容易在
      // 编辑正式文档时把原文一并抹掉（redaction 不可逆），这条能力收回到
      // CLI / HTTP（pdfx erase、POST /api/erase）里，界面不再暴露。
      bar.innerHTML = `<span>橡皮大小</span>
        <input type="range" id="era-size" min="3" max="60" step="1" value="${S.eraser.radius}" />
        <span class="val" id="era-val">${S.eraser.radius}</span>
        <span class="hint" style="margin:0">只擦你自己画的笔迹，页面原有文字与图片不受影响</span>`;
      $('#era-size').oninput = (e) => {
        S.eraser.radius = parseFloat(e.target.value);
        $('#era-val').textContent = S.eraser.radius;
        drawOverlay();
      };
    } else if (S.tool === 'text') {
      bar.innerHTML = `<span>字号</span><input type="number" id="txt-size" min="5" max="96" step="0.5" value="${S.textStyle.size}" />
        <span>颜色</span><input type="color" id="txt-color" value="${S.textStyle.color}" />
        <span class="hint" style="margin:0">在页面上点一下即可输入；也可拖出想要的宽度</span>`;
      $('#txt-size').oninput = (e) => (S.textStyle.size = parseFloat(e.target.value) || 12);
      $('#txt-color').oninput = (e) => (S.textStyle.color = e.target.value);
    } else {
      bar.classList.remove('show');
      return;
    }
    bar.classList.add('show');
  }

  $$('#tools .tool').forEach((b) => (b.onclick = () => setTool(b.dataset.tool)));

  /* ------------------------------------------------------------------ 视图切换 */
  function setView(v) {
    S.view = v;
    $$('.vbtn').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
    syncStageClass();
    renderPages();
  }
  $$('.vbtn').forEach((b) => (b.onclick = () => setView(b.dataset.view)));

  /* ------------------------------------------------------------------ 页面增删 */
  $('#btn-add-page').onclick = async () => {
    if (!S.doc) return toast('先打开或新建一个文档', 'err');
    try {
      const r = await api('/api/page', { json: { page: S.page, size: 'a4', at: S.page + 1 } });
      S.pageCount = r.page_count;
      S.sizes = (r.pages || []).map((p) => p.size || S.size);
      await renderThumbs();
      await setCurrentPage(Math.min(S.page + 1, S.pageCount - 1), { scroll: true });
      renderPages();
      renderDocList();
      toast('已添加一页空白页', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  };

  $('#btn-del-page').onclick = async () => {
    if (!S.doc) return;
    if (S.pageCount <= 1) return toast('不能删除唯一页面', 'err');
    const okDel = await dialog({
      title: '删除页面',
      html: `<p>确定删除第 <b>${S.page + 1}</b> 页？该操作可用「撤销」恢复。</p>`,
      okText: '删除',
    });
    if (!okDel) return;
    try {
      const r = await api('/api/page', { method: 'DELETE', json: { pages: S.page } });
      S.pageCount = r.page_count;
      S.sizes = (r.pages || []).map((p) => p.size || S.size);
      await renderThumbs();
      await setCurrentPage(Math.min(S.page, S.pageCount - 1), { scroll: true });
      renderPages();
      renderDocList();
      toast('已删除', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  };

  /* ------------------------------------------------------------------ 文件操作 */
  /* 上次去过的目录。默认落在用户目录（C 盘）不够用 —— 教材常放在 D/E 盘，
     记一下就能接着上次的位置翻，不用每次从 C 盘一路点下去。 */
  function lastDir() {
    try { return localStorage.getItem('pdfx.lastDir') || ''; } catch (e) { return ''; }
  }
  function setLastDir(dir) {
    try { if (dir) localStorage.setItem('pdfx.lastDir', dir); } catch (e) { /* 隐私模式 */ }
  }

  /* 通用目录浏览器：盘符条 + 当前位置 + 上级 + 子目录（可选 PDF 文件）。
     三处用到（打开 / 保存 / 分割输出目录）。以前各写一份，都是只有「↑ 上级目录」，
     Windows 上到 C:\ 之后 parent 还是 C:\，换不到 D 盘 —— 只能先把文件拷到 C 盘。 */
  async function mountBrowser(box, opts = {}) {
    const { files = false, pickDir = null, onDir = null, onFile = null } = opts;
    let roots = [];
    async function nav(p) {
      let r = null;
      try {
        const qs = ['fallback=1'];
        if (p) qs.push('dir=' + encodeURIComponent(p));
        r = await api('/api/browse?' + qs.join('&'));
      } catch (e) {
        // 真的进不去（权限不足、盘符被拔掉）：别把整个浏览器弄死，给条退路
        box.innerHTML = '';
        const bad = document.createElement('div');
        bad.className = 'path warn';
        bad.textContent = e.message;
        box.appendChild(bad);
        const back = document.createElement('div');
        back.className = 'item';
        back.textContent = '← 回到我的文档';
        back.onclick = () => nav('');
        box.appendChild(back);
        return;
      }
      roots = (r.roots && r.roots.length) ? r.roots : roots;
      setLastDir(r.dir);
      if (onDir) onDir(r.dir);

      box.innerHTML = '';
      // 盘符条：只有一个根（macOS/Linux）时不显示，省得占一行
      if (roots.length > 1) {
        const bar = document.createElement('div');
        bar.className = 'drives';
        roots.forEach((rt) => {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'drive' + (rt.path.toLowerCase() === r.dir.toLowerCase() ? ' on' : '');
          b.textContent = rt.name;
          b.title = rt.path;
          b.onclick = () => nav(rt.path);
          bar.appendChild(b);
        });
        box.appendChild(bar);
      }

      const head = document.createElement('div');
      head.className = 'path';
      head.textContent = r.dir;
      box.appendChild(head);

      // 目录还没建（分割的默认输出目录就是这种）：说明一下为什么不是刚才那个路径
      // 比较前先归一（斜杠方向、末尾分隔符、大小写），否则 C:/a 与 C:\a 会被判成不同
      const norm = (s) => String(s || '').replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase();
      if (r.requested && norm(r.requested) !== norm(r.dir)) {
        const tip = document.createElement('div');
        tip.className = 'path warn';
        tip.textContent = `${r.requested} 还不存在，已跳到上级目录`;
        box.appendChild(tip);
      }

      // 到了盘符根就没有"上级"了（上一层是盘符条）
      if (r.parent) {
        const up = document.createElement('div');
        up.className = 'item';
        up.textContent = '↑ 上级目录';
        up.onclick = () => nav(r.parent);
        box.appendChild(up);
      }

      r.items.filter((it) => it.dir || (files && it.pdf)).forEach((it) => {
        const row = document.createElement('div');
        row.className = 'item' + (it.dir ? '' : ' isfile');
        row.innerHTML = `<span>${it.dir ? '📁' : '📄'} ${esc(it.name)}</span>`
          + (it.dir ? '' : `<span class="sz">${fmtSize(it.size)}</span>`);
        row.onclick = () => {
          if (it.dir) nav(it.path);
          else if (onFile) onFile(it.path);
        };
        box.appendChild(row);
      });

      if (pickDir) {
        const pick = document.createElement('div');
        pick.className = 'item sp-pick-here';
        pick.innerHTML = `<span>✓ ${esc(pickDir(r.dir))}</span>`;
        pick.onclick = () => opts.onPickDir && opts.onPickDir(r.dir);
        box.appendChild(pick);
      }
    }
    await nav(opts.start || '');
    return { nav };
  }

  /* 通用文件浏览对话框，返回选中的 PDF 路径 */
  function browseDialog({ title, okText, startDir }) {
    const html = `<div class="field"><label>文件路径</label>
        <input type="text" data-field="path" id="f-path" placeholder="可直接粘贴完整路径，或从下方浏览" /></div>
      <div class="browser" id="browser"><div class="path">加载中…</div></div>
      <div class="hint">也可以直接把文件拖到窗口里。</div>`;
    return dialog({
      title,
      html,
      okText,
      onMount: (el) => {
        mountBrowser(el.querySelector('#browser'), {
          start: startDir || '',
          files: true,
          onFile: (p) => { el.querySelector('#f-path').value = p; },
        });
      },
    });
  }

  /* ------------------------------------------------------------------ 菜单栏 */
  /* 顶栏两个下拉：文件（新建/打开/保存/另存为/插入/撤销）、
   * 功能（分割导出/OCR/文本块/页面/快捷键）。
   *
   * 弹出层用 position:fixed 而不是 absolute —— 顶栏为了窄屏横滚设了
   * overflow-x:auto，绝对定位的子元素会被裁掉，菜单会"点开却看不见"。
   * 坐标在打开的那一刻量一次；页面一滚动就收起，免得菜单飘在原地。 */
  (function setupMenubar() {
    const bar = $('#menubar');
    if (!bar) return;
    const menus = Array.from(bar.querySelectorAll('.menu'));
    let openIdx = -1;

    function close(refocus) {
      const was = openIdx;
      menus.forEach((m) => {
        m.classList.remove('open');
        const b = m.querySelector('.menu-btn');
        if (b) b.setAttribute('aria-expanded', 'false');
      });
      openIdx = -1;
      if (refocus && was >= 0) {
        const b = menus[was].querySelector('.menu-btn');
        if (b) b.focus();
      }
    }

    function place(m) {
      const btn = m.querySelector('.menu-btn');
      const pop = m.querySelector('.menu-pop');
      if (!btn || !pop) return;
      const r = btn.getBoundingClientRect();
      // 顶栏下沿比按钮下沿更低（按钮在 50px 里居中只有 30px 高），
      // 取两者较大值，菜单才是"吊在顶栏外面"而不是压住下边框
      const barEl = bar.closest('.topbar') || bar;
      const barBottom = barEl.getBoundingClientRect().bottom;
      // 先归零再量：上一轮的位置可能把宽度撑到视口外
      pop.style.left = '0px';
      pop.style.top = '0px';
      const w = pop.offsetWidth || 238;
      const left = Math.max(8, Math.min(Math.round(r.left), innerWidth - w - 8));
      pop.style.left = left + 'px';
      pop.style.top = Math.round(Math.max(r.bottom + 6, barBottom + 4)) + 'px';
    }

    function open(i) {
      menus.forEach((m, k) => {
        const on = k === i;
        m.classList.toggle('open', on);
        const b = m.querySelector('.menu-btn');
        if (b) b.setAttribute('aria-expanded', on ? 'true' : 'false');
      });
      openIdx = i;
      place(menus[i]);
    }

    menus.forEach((m, i) => {
      const btn = m.querySelector('.menu-btn');
      if (!btn) return;
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (openIdx === i) close();
        else open(i);
      });
      // 已有菜单开着时，划过另一个直接切过去（桌面软件的通常手感）
      btn.addEventListener('mouseenter', () => {
        if (openIdx >= 0 && openIdx !== i) open(i);
      });
    });

    /* 点菜单项：先让元素自己的 onclick 跑完（那些是 btn-* 的既有绑定），
       冒泡到 menubar 这里再收起。不能用 onclick= 覆盖，会把原动作顶掉。 */
    bar.addEventListener('click', (e) => {
      if (e.target.closest('.mi')) close();
    });

    document.addEventListener('click', (e) => {
      if (openIdx >= 0 && !bar.contains(e.target)) close();
    });

    document.addEventListener('keydown', (e) => {
      if (openIdx < 0) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        close(true);
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const items = Array.from(menus[openIdx].querySelectorAll('.mi'));
        if (!items.length) return;
        const at = items.indexOf(document.activeElement);
        const step = e.key === 'ArrowDown' ? 1 : -1;
        const next = at < 0
          ? (step > 0 ? 0 : items.length - 1)
          : (at + step + items.length) % items.length;
        items[next].focus();
      }
    });

    window.addEventListener('resize', () => { if (openIdx >= 0) close(); });
    window.addEventListener('blur', () => { if (openIdx >= 0) close(); });
    const stage = $('#stage-wrap');
    if (stage) stage.addEventListener('scroll', () => { if (openIdx >= 0) close(); }, { passive: true });
    // 顶栏左段横滚时菜单位置就不对了（fixed 是按视口算的）
    const tbLeft = $('.tb-left');
    if (tbLeft) tbLeft.addEventListener('scroll', () => { if (openIdx >= 0) close(); }, { passive: true });
  })();

  /* 菜单里新增的两个入口 */
  $('#btn-saveas').onclick = () => saveAs();
  const ocrMenuBtn = $('#btn-ocr-menu');
  if (ocrMenuBtn) ocrMenuBtn.onclick = () => doOcrPage();

  $('#btn-open').onclick = () => openFileDialog();

  async function openFileDialog() {
    const r = await browseDialog({ title: '打开 PDF', okText: '打开', startDir: lastDir() });
    if (r && r.path) {
      try {
        const info = await api('/api/open', { json: { path: r.path } });
        await loadInfo(info);
        toast('已打开 ' + baseName(r.path), 'ok');
      } catch (e) { toast(e.message, 'err'); }
    }
  }

  /* 新建：生成一份独立文档，不继承上一个文档的路径 */
  async function newDocument() {
    try {
      const r = await api('/api/new', { json: { size: 'a4', pages: 1 } });
      await loadInfo(r);
      toast('已新建空白文档（尚未保存）', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  }
  $('#btn-new').onclick = () => newDocument();

  /* ---- 插入另一个 PDF 的页面 ---- */
  $('#btn-insert-pdf').onclick = async () => {
    if (!S.doc) return toast('先打开或新建一个文档', 'err');
    const picked = await browseDialog({ title: '插入 PDF —— 选择文件', okText: '下一步', startDir: lastDir() });
    if (!picked || !picked.path) return;
    const ask = await dialog({
      title: '插入 PDF —— 选择页面',
      okText: '插入',
      html: `
        <div class="field"><label>源文件</label><input type="text" readonly value="${esc(picked.path)}" /></div>
        <div class="field"><label>要插入的页面</label>
          <input type="text" data-field="pages" value="all" placeholder="all / 1-3 / 1,3,5" /></div>
        <div class="field"><label>插入位置</label>
          <select data-field="at">
            <option value="after" selected>当前页之后（第 ${S.page + 1} 页后面）</option>
            <option value="end">文档末尾</option>
            <option value="start">文档最前</option>
          </select></div>
        <div class="hint">页面范围写 <b>all</b> 表示全部；页码从 1 开始数。</div>`,
    });
    if (!ask) return;
    const atMap = { after: S.page + 1, end: null, start: 0 };
    try {
      const r = await api('/api/page/import', {
        json: {
          path: picked.path,
          pages: ask.pages || 'all',
          at: atMap[ask.at] === null ? null : atMap[ask.at],
        },
      });
      S.pageCount = r.page_count;
      S.sizes = (r.pages || []).map((p) => p.size || S.size);
      await renderThumbs();
      await setCurrentPage((r.imported && r.imported[0]) || S.page, { scroll: true });
      renderPages();
      renderDocList();
      toast(`已插入 ${r.imported_count} 页`, 'ok');
    } catch (e) { toast(e.message, 'err'); }
  };

  /* ------------------------------------------------------------------ 批量分割 */
  /* 400 页的教材按 1-10 / 11-30 / 31-40 拆成 3 份 —— 边填边看会切出哪些文件，
   * 确认后后台跑，跑完在面板里直接看结果。
   *
   * 为什么是右侧栏而不是弹窗：分割时得"看着页面决定切哪几页"，
   * 720px 的弹窗正好压住整张纸，只能反复关掉再打开。现在它和「对象 / 属性」
   * 面板共用右侧那一列（打开时顶掉对象面板），画布一直露着。
   *
   * 三个约定：
   *  1) 页码范围是 **1 基闭区间**（1-10 = 第 1~10 页）。库内其它接口都是 0 基，
   *     但"用户手写的页码范围"不可能是 0 基，换算统一放在后端做一次。
   *  2) 400 页拆 8 份要几十秒，同步请求会先超时，所以走后台任务 + 轮询。
   *  3) 面板 DOM 只建一次：收起再打开，填好的页码范围、跑完的结果都还在
   *     （弹窗每次重建，用户改完参数去核对页面，回来就白填了）。
   */
  function splitPanelOpen() {
    const p = $('#split-panel');
    return !!p && !p.hidden;
  }

  /* 右侧那一列现在归谁：分割面板开着就算它，否则看对象面板。
     顶栏按钮 / 功能菜单的勾选态都跟着这里走，避免两处各说各话。 */
  function syncPanelEntries() {
    const isSplit = splitPanelOpen();
    const any = isSplit || inspOpen();
    const top = $('#btn-inspector');
    if (top) {
      top.classList.toggle('off', !any);
      top.classList.toggle('active', any);
      top.setAttribute('aria-expanded', any ? 'true' : 'false');
      top.title = any
        ? (isSplit ? '收起分割面板，回到对象面板 (Ctrl+B)' : '收起右侧面板 (Ctrl+B)')
        : '展开右侧面板 (Ctrl+B)';
    }
    const mi = $('#btn-inspector-menu');
    if (mi) {
      mi.classList.toggle('active', any);
      mi.title = any ? '点一下收起，把宽度让给页面' : '当前已收起；点一下展开';
    }
    const sp = $('#btn-split');
    if (sp) sp.classList.toggle('active', isSplit);
  }

  function showSplitPanel() {
    const p = $('#split-panel');
    const l = $('#layout');
    if (!p || !l) return;
    p.hidden = false;
    p.setAttribute('aria-hidden', 'false');
    l.classList.add('split-open');
    syncPanelEntries();
    // 列宽变了两次（先让出对象面板、再换成更宽的一列），动画结束各重画一次
    baseRect = null;
    requestAnimationFrame(drawOverlay);
    setTimeout(() => { baseRect = null; drawOverlay(); }, 240);
  }

  function hideSplitPanel() {
    const p = $('#split-panel');
    const l = $('#layout');
    if (!p || !l) return;
    p.hidden = true;
    p.setAttribute('aria-hidden', 'true');
    l.classList.remove('split-open');
    syncPanelEntries();
    baseRect = null;
    requestAnimationFrame(drawOverlay);
    setTimeout(() => { baseRect = null; drawOverlay(); }, 240);
  }

  /* 收起分割面板：右侧那一列交还给对象面板。原本被收起过就顺手展开，
     否则按一下「收起」右边一片空白，看着像把面板弄丢了。 */
  function closeSplitPanel() {
    hideSplitPanel();
    if (!inspOpen()) setInspector(true, false);
  }

  function openSplitPanel() {
    if (!S.doc) return toast('先打开或新建一个文档', 'err');
    if (!splitMounted) mountSplitPanel();
    showSplitPanel();
    if (splitShow) splitShow();
  }

  function mountSplitPanel() {
    splitMounted = true;
    const bodyEl = $('#split-body');
    const footEl = $('#split-foot');
    const st = {
      mode: 'ranges',
      srcPath: '',
      timer: 0,
      plan: null,
      running: false,
      job: '',
      outTouched: false,
      preTouched: false,
      doc: S.doc,
    };
    const firstRanges = `1-${Math.min(10, Math.max(1, S.pageCount))}`;
    const every0 = Math.max(1, Math.min(50, Math.ceil((S.pageCount || 1) / 4)));

    bodyEl.innerHTML = `
      <div class="split" id="sp-form">
        <div class="sp-src">
          <div class="sp-src-main">
            <div class="sp-src-name" id="sp-src-name">${esc(baseName(S.path) || '（未保存的文档）')}</div>
            <div class="sp-src-meta" id="sp-src-meta">当前文档 · ${S.pageCount} 页${S.path ? '' : ' · 尚未保存'}</div>
          </div>
          <button class="btn small" id="sp-pick">选择其他文件…</button>
        </div>

        <div class="sp-modes" id="sp-modes">
          <button class="sp-mode active" data-mode="ranges">页码范围</button>
          <button class="sp-mode" data-mode="every">每 N 页</button>
          <button class="sp-mode" data-mode="toc">按目录书签</button>
        </div>

        <div class="sp-pane" data-pane="ranges">
          <textarea id="sp-ranges" spellcheck="false">${esc(firstRanges)}</textarea>
          <div class="hint">每行一段，也能用逗号隔开。页码从 <b>1</b> 开始、含首尾；
            <code>1-</code> 表示到最后一页；<code>1-10:封面</code> 可单独给这一段起文件名。</div>
        </div>

        <div class="sp-pane" data-pane="every" hidden>
          <div class="field row">
            <div><label>每份页数</label><input type="number" id="sp-every" min="1" step="1" value="${every0}" /></div>
            <div><label>预计</label><div class="sp-calc" id="sp-every-calc">—</div></div>
          </div>
        </div>

        <div class="sp-pane" data-pane="toc" hidden>
          <div class="field row">
            <div><label>目录层级</label>
              <select id="sp-level">
                <option value="1">1 级（章）</option>
                <option value="2">2 级（节）</option>
                <option value="3">3 级</option>
              </select></div>
            <div><label>预计</label><div class="sp-calc" id="sp-toc-calc">—</div></div>
          </div>
          <div class="hint">按书签切，文件名会带上章节标题。没有目录的 PDF 会直接提示换一种方式。</div>
        </div>

        <div class="sp-out">
          <div class="field"><label>输出目录</label>
            <div class="sp-row">
              <input type="text" id="sp-outdir" placeholder="默认：源文件旁 <书名>_split/" />
              <button class="btn small" id="sp-browse-dir">换目录</button>
            </div>
          </div>
          <div class="field"><label>文件名前缀</label>
            <input type="text" id="sp-prefix" placeholder="默认取源文件名" />
          </div>
          <label class="chk"><input type="checkbox" id="sp-overwrite" /> 覆盖同名文件</label>
        </div>

        <div class="sp-summary" id="sp-summary">正在计算…</div>
        <div class="sp-rows-wrap">
          <table class="sp-table">
            <thead><tr><th>#</th><th>页码</th><th>页数</th><th>文件名</th></tr></thead>
            <tbody id="sp-rows"></tbody>
          </table>
        </div>
        <div class="sp-warns" id="sp-warns"></div>
      </div>

      <div class="sp-progress" id="sp-progress" hidden>
        <div class="sp-bar"><i id="sp-bar-fill"></i></div>
        <div class="sp-prog-text" id="sp-prog-text">准备中…</div>
        <div class="actions" style="margin-top:12px">
          <button class="btn" id="sp-cancel">取消这次分割</button>
        </div>
      </div>

      <div class="sp-done" id="sp-done" hidden></div>`;

    /* 面板里的 DOM 和原来的弹窗一模一样，所以下面的逻辑原样沿用：
       body = 面板内容容器，close = 收起面板，btns.ok = 底栏的「开始分割」 */
    const body = bodyEl;
    const close = () => closeSplitPanel();
    const btns = { ok: $('#sp-start'), cancel: null };
    const formEl = body.querySelector('#sp-form');
    const progEl = body.querySelector('#sp-progress');
    const doneEl = body.querySelector('#sp-done');
    const rowsEl = body.querySelector('#sp-rows');
    const sumEl = body.querySelector('#sp-summary');
    const warnEl = body.querySelector('#sp-warns');
    const rangesEl = body.querySelector('#sp-ranges');
    const everyEl = body.querySelector('#sp-every');
    const levelEl = body.querySelector('#sp-level');
    const outEl = body.querySelector('#sp-outdir');
    const preEl = body.querySelector('#sp-prefix');
    const overEl = body.querySelector('#sp-overwrite');
    const barEl = body.querySelector('#sp-bar-fill');
    const progText = body.querySelector('#sp-prog-text');
    const srcNameEl = body.querySelector('#sp-src-name');
    const srcMetaEl = body.querySelector('#sp-src-meta');

    const payload = () => {
      const p = {
        mode: st.mode,
        ranges: st.mode === 'ranges' ? rangesEl.value : '',
        every: st.mode === 'every' ? parseInt(everyEl.value, 10) || 0 : 0,
        level: st.mode === 'toc' ? parseInt(levelEl.value, 10) || 1 : 1,
        out_dir: outEl.value.trim(),
        prefix: preEl.value.trim(),
        overwrite: overEl.checked,
      };
      if (st.srcPath) p.path = st.srcPath;
      else p.doc = S.doc;
      return p;
    };

    function setMode(mode) {
      st.mode = mode;
      body.querySelectorAll('.sp-mode').forEach((b) =>
        b.classList.toggle('active', b.dataset.mode === mode)
      );
      body.querySelectorAll('.sp-pane').forEach((p) =>
        (p.hidden = p.dataset.pane !== mode)
      );
      preview();
    }
    body.querySelectorAll('.sp-mode').forEach((b) => {
      b.onclick = () => setMode(b.dataset.mode);
    });

    function renderError(msg) {
      st.plan = null;
      rowsEl.innerHTML = `<tr><td colspan="4" class="sp-bad">${esc(msg)}</td></tr>`;
      sumEl.textContent = '还差一步';
      warnEl.innerHTML = '';
      if (btns.ok) btns.ok.disabled = true;
      body.querySelector('#sp-every-calc').textContent = '—';
      body.querySelector('#sp-toc-calc').textContent = '—';
    }

    function renderPlan(pl) {
      st.plan = pl;
      if (!st.outTouched && pl.out_dir) outEl.value = pl.out_dir;
      if (!st.preTouched) preEl.value = pl.prefix || '';
      const parts = pl.parts || [];
      rowsEl.innerHTML = parts.length
        ? parts
            .map(
              (p) => `<tr>
                <td class="num">${p.index + 1}</td>
                <td>${p.from === p.to ? p.from : p.from + '–' + p.to}</td>
                <td class="num">${p.pages}</td>
                <td class="fn" title="${esc(p.path)}">${esc(p.file)}${
                  p.exists ? '<span class="sp-tag">已存在</span>' : ''
                }</td></tr>`
            )
            .join('')
        : '<tr><td colspan="4" class="muted">没有分段</td></tr>';
      const dup = pl.duplicated && pl.duplicated.length;
      const gap = pl.uncovered && pl.uncovered.length;
      sumEl.innerHTML =
        `共 <b>${pl.part_count}</b> 个文件 · 覆盖 <b>${pl.unique_pages}</b>/${pl.page_count} 页` +
        (dup ? ` · <span class="sp-warn-t">有页面重复</span>` : '') +
        (gap ? ` · <span class="sp-warn-t">有页面遗漏</span>` : '');
      warnEl.innerHTML = (pl.warnings || [])
        .map((w) => `<div class="sp-warn">${esc(w)}</div>`)
        .join('');
      if (pl.mode === 'every') {
        body.querySelector('#sp-every-calc').textContent = `${pl.part_count} 份`;
      }
      if (pl.mode === 'toc') {
        body.querySelector('#sp-toc-calc').textContent = `${pl.part_count} 份`;
      }
      if (btns.ok) btns.ok.disabled = !parts.length;
    }

    async function preview() {
      if (st.running) return;
      if (st.timer) {
        clearTimeout(st.timer);
        st.timer = 0;
      }
      sumEl.textContent = '正在计算…';
      try {
        const pl = await api('/api/split/plan', { json: payload() });
        srcNameEl.textContent = baseName(pl.source) || '（未保存的文档）';
        srcMetaEl.innerHTML =
          `${st.srcPath ? '单独选择' : '当前文档'} · ${pl.page_count} 页` +
          (st.srcPath
            ? ' · <a href="#" id="sp-src-back">改回当前文档</a>'
            : S.path ? '' : ' · 尚未保存');
        const backSrc = srcMetaEl.querySelector('#sp-src-back');
        if (backSrc) {
          backSrc.onclick = (ev2) => {
            ev2.preventDefault();
            st.srcPath = '';
            st.outTouched = false;
            st.preTouched = false;
            preview();
          };
        }
        renderPlan(pl);
      } catch (e) {
        renderError(e.message);
      }
    }
    const schedule = () => {
      clearTimeout(st.timer);
      st.timer = setTimeout(preview, 260);
    };

    rangesEl.oninput = schedule;
    everyEl.oninput = schedule;
    levelEl.onchange = () => preview();
    outEl.oninput = () => {
      st.outTouched = true;
      schedule();
    };
    preEl.oninput = () => {
      st.preTouched = true;
      schedule();
    };
    overEl.onchange = () => {
      if (overEl.checked && st.plan && st.plan.conflicts.length) schedule();
    };

    /* 换输出目录：复用系统文件框太别扭，这里给一个"目录列表"弹层 ——
       但它会和主弹窗抢同一个 #modal，所以改成在弹窗内就地展开目录。 */
    body.querySelector('#sp-browse-dir').onclick = () => {
      const box = document.createElement('div');
      box.className = 'sp-browser';
      box.innerHTML = '<div class="path">加载中…</div>';
      outEl.parentElement.parentElement.appendChild(box);
      const shortName = (p) => p.replace(/\\/g, '/').split('/').filter(Boolean).pop() || p;
      mountBrowser(box, {
        start: outEl.value.trim(),
        pickDir: (dir) => `用这个目录：${shortName(dir)}`,
        onPickDir: (dir) => {
          outEl.value = dir;
          st.outTouched = true;
          box.remove();
          preview();
        },
      });
    };

    /* 选另一份 PDF：走系统文件框上传到临时目录，不打开成新文档 */
    body.querySelector('#sp-pick').onclick = async () => {
      const f = await pickFile('pdf');
      if (!f) return;
      try {
        const fd = new FormData();
        fd.append('file', f);
        const res = await fetch('/api/upload?no_open=1', { method: 'POST', body: fd });
        const j = await res.json();
        if (!j.ok) throw new Error(j.error.message);
        st.srcPath = j.data.path;
        st.outTouched = false;
        st.preTouched = false;
        preview();
      } catch (e) {
        toast(e.message, 'err');
      }
    };

    function showJob(j) {
      if (j.state === 'running') {
        const done = Math.min(j.done || 0, j.total || 0);
        const pct = j.total ? Math.round((done / j.total) * 100) : 8;
        barEl.style.width = Math.max(4, pct) + '%';
        progText.textContent =
          `正在导出 ${Math.min(done + 1, j.total || done + 1)}/${j.total || '?'}` +
          (j.current ? ` · ${j.current}` : '');
        return;
      }
      st.running = false;
      progEl.hidden = true;
      doneEl.hidden = false;
      body.scrollTop = 0;
      const files = j.files || [];
      if (j.state === 'error') {
        const e = j.error || {};
        doneEl.innerHTML = `<div class="sp-done-head sp-bad">分割失败</div>
          <div class="hint warn">${esc(e.message || '未知错误')}</div>
          <div class="actions"><button class="btn" id="sp-back">返回修改</button></div>`;
      } else {
        doneEl.innerHTML = `
          <div class="sp-done-head">${j.state === 'cancelled' ? '已取消' : `已导出 ${files.length} 个文件`}</div>
          <div class="sp-done-dir">${esc(j.out_dir || '')}</div>
          <div class="sp-files">${files
            .map(
              (f) => `<div class="sp-file">
                <span class="sf-name" title="${esc(f.path)}">${esc(f.file)}</span>
                <span class="sf-meta">${f.from === f.to ? '第 ' + f.from + ' 页' : '第 ' + f.from + '–' + f.to + ' 页'} · ${f.pages} 页 · ${fmtSize(f.bytes)}</span>
                <button class="btn small" data-open="${esc(f.path)}">打开</button>
              </div>`
            )
            .join('')}</div>
          ${(j.warnings || []).map((w) => `<div class="sp-warn">${esc(w)}</div>`).join('')}
          <div class="actions">
            <button class="btn" id="sp-again">再分一批</button>
            <button class="btn primary" id="sp-done-close">完成</button>
          </div>`;
      }
      doneEl.querySelectorAll('[data-open]').forEach((b) => {
        b.onclick = async () => {
          try {
            const info = await api('/api/open', { json: { path: b.dataset.open } });
            await loadInfo(info);
            close(null);
            toast('已打开 ' + baseName(b.dataset.open), 'ok');
          } catch (e) {
            toast(e.message, 'err');
          }
        };
      });
      const again = doneEl.querySelector('#sp-again');
      if (again) again.onclick = resetToForm;
      const dc = doneEl.querySelector('#sp-done-close');
      if (dc) dc.onclick = () => close(null);
      const back2 = doneEl.querySelector('#sp-back');
      if (back2) back2.onclick = resetToForm;
      if (btns.cancel) btns.cancel.textContent = '关闭';
      // 结果区自带「再分一批 / 完成」，底部整栏就让出来（否则同一件事有两个按钮）
      if (btns.ok) {
        btns.ok.style.display = 'none';
        btns.ok.parentElement.hidden = true;
      }
      if (btns.cancel) btns.cancel.style.display = 'none';
    }

    async function poll() {
      // 面板收起后别停轮询：DOM 还在（只是 hidden），跑完的结果要留着给下次展开看。
      // 真正要防的是"内容被重建"—— 那之后这些元素已经不在文档里了。
      if (!document.body.contains(formEl)) return;
      let j = null;
      try {
        j = await api('/api/split/job?id=' + encodeURIComponent(st.job));
      } catch (e) {
        st.running = false;
        progEl.hidden = true;
        formEl.hidden = false;
        if (btns.ok) btns.ok.disabled = false;
        return toast(e.message, 'err');
      }
      showJob(j);
      if (j.state === 'running') setTimeout(poll, 350);
    }

    /* 主按钮：开始分割。跑的过程中面板不关，结果留在面板里 */
    async function startSplit() {
      if (st.running) return;
      // 刚改完参数就点开始（防抖还没到）：先按最新输入重算一遍，
      // 免得"预览是 2 份、实际切出 3 份"
      if (st.timer) {
        clearTimeout(st.timer);
        st.timer = 0;
        await preview();
      }
      if (!st.plan || !st.plan.parts || !st.plan.parts.length) {
        return toast('先填好页码范围', 'err');
      }
      if (st.plan.conflicts && st.plan.conflicts.length && !overEl.checked) {
        return toast(`有 ${st.plan.conflicts.length} 个同名文件，勾选「覆盖同名文件」后才能继续`, 'err');
      }
      st.running = true;
      btns.ok.disabled = true;
      if (btns.cancel) btns.cancel.disabled = true;
      formEl.hidden = true;
      doneEl.hidden = true;
      progEl.hidden = false;
      barEl.style.width = '4%';
      progText.textContent = '准备中…';
      try {
        const r = await api('/api/split', { json: payload() });
        st.job = r.job_id;
        setTimeout(poll, 200);
      } catch (e) {
        st.running = false;
        progEl.hidden = true;
        formEl.hidden = false;
        btns.ok.disabled = false;
        if (btns.cancel) btns.cancel.disabled = false;
        toast(e.message, 'err');
      }
    }

    function resetToForm() {
      doneEl.hidden = true;
      doneEl.innerHTML = '';
      formEl.hidden = false;
      overEl.checked = false;
      if (btns.cancel) btns.cancel.textContent = '取消';
      if (btns.ok) {
        btns.ok.parentElement.hidden = false;
        btns.ok.style.display = '';
        btns.ok.textContent = '开始分割';
        btns.ok.disabled = false;
        btns.ok.onclick = startSplit;
      }
      if (btns.cancel) btns.cancel.style.display = '';
      preview();
    }

    if (btns.ok) btns.ok.onclick = startSplit;

    body.querySelector('#sp-cancel').onclick = async () => {
      if (!st.job) return;
      try {
        await api('/api/split/cancel', { json: { id: st.job } });
        progText.textContent = '正在取消（做完手上这一份就停）…';
      } catch (e) {
        toast(e.message, 'err');
      }
    };

    preview();

    /* 每次展开面板都刷一下：换过文档就按新文档重填默认值，
       否则只重算预览（跑着的时候别动，不然进度条会被表单盖住） */
    splitShow = () => {
      if (st.running) return;
      if (!st.srcPath && st.doc !== S.doc) {
        st.doc = S.doc;
        st.outTouched = false;
        st.preTouched = false;
        rangesEl.value = `1-${Math.min(10, Math.max(1, S.pageCount))}`;
        everyEl.value = Math.max(1, Math.min(50, Math.ceil((S.pageCount || 1) / 4)));
        outEl.value = '';
        preEl.value = '';
      }
      preview();
    };
  }
  $('#btn-split').onclick = () => openSplitPanel();
  $('#sp-close').onclick = () => closeSplitPanel();
  $('#sp-close2').onclick = () => closeSplitPanel();

  /* ---- 保存 ---- */
  async function defaultSavePath() {
    // 上次去过的目录优先 —— 但那个目录可能已经被删了，先用一次 browse 验证，
    // 不行再退回用户目录，免得一打开保存框就是个不存在的路径
    let dir = lastDir();
    if (dir) {
      try { dir = (await api('/api/browse?dir=' + encodeURIComponent(dir))).dir; }
      catch (e) { dir = ''; }
    }
    if (!dir) {
      try { dir = (await api('/api/browse')).dir || ''; } catch (e) { dir = ''; }
    }
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
    const sep = dir.includes('\\') ? '\\' : '/';
    return dir ? `${dir}${sep}未命名-${stamp}.pdf` : `未命名-${stamp}.pdf`;
  }

  async function saveAs() {
    if (!S.doc) return toast('先打开或新建一个文档', 'err');
    const isAs = !!S.path;
    let def = await defaultSavePath();
    // 另存为默认落在原名旁边加「-副本」，不用再从"未命名"里找
    if (isAs) def = S.path.replace(/\.pdf$/i, '') + '-副本.pdf';
    const r = await dialog({
      title: isAs ? '另存为' : '保存新文档',
      okText: '保存到该路径',
      html: `
        <div class="field"><label>保存路径（可修改）</label>
          <input type="text" data-field="path" id="s-path" value="${esc(def)}" /></div>
        <div class="browser" id="s-browser"><div class="path">加载中…</div></div>
        <div class="hint">${isAs
          ? '会另存一份到上面这个路径，之后 <b>Ctrl+S</b> 就存到这里；原文件不动。'
          : '这是一份<b>新建文档</b>，还没有保存到磁盘。确认上面的完整路径后点「保存到该路径」。'}</div>`,
      onMount: async (el) => {
        const box = el.querySelector('#s-browser');
        const input = el.querySelector('#s-path');
        mountBrowser(box, {
          // 从路径框里已有的目录开始，别让浏览框显示 home 而输入框是别的盘
          start: String(def).replace(/[\\/][^\\/]*$/, ''),
          onDir: (dir) => {
            // 切目录时保留文件名，只换目录
            const name = baseName(input.value) || '未命名.pdf';
            const sep = dir.includes('\\') ? '\\' : '/';
            input.value = dir + sep + name;
          },
        });
      },
    });
    if (!r || !r.path) return null;
    if (!/\.pdf$/i.test(r.path)) r.path += '.pdf';
    try {
      const res = await api('/api/save', { json: { path: r.path, as_current: true } });
      S.path = res.path;
      setLastDir(String(res.path).replace(/[\\/][^\\/]*$/, ''));
      await refreshDocList();
      toast('已保存到 ' + res.path, 'ok');
      return res.path;
    } catch (e) {
      toast(e.message, 'err');
      return null;
    }
  }

  async function doSave() {
    if (!S.doc) return toast('没有打开的文档', 'err');
    if (!S.path) return saveAs();
    try {
      const r = await api('/api/save', { json: { incremental: false } });
      S.path = r.path || S.path;
      await refreshDocList();
      toast('已保存 · ' + fmtSize(r.size), 'ok');
    } catch (e) {
      if (e.code === 'no_path') return saveAs();
      toast(e.message, 'err');
    }
  }

  $('#btn-save').onclick = () => doSave();

  $('#btn-undo').onclick = async () => {
    if (!S.doc) return;
    try {
      const r = await api('/api/undo', { json: {} });
      if (!r.undone) return toast('没有可撤销的操作', 'err');
      S.pageCount = r.page_count;
      S.sizes = (r.pages || []).map((p) => p.size || S.size);
      S.sel = null;
      S.hits = [];
      await renderThumbs();
      await setCurrentPage(Math.min(S.page, S.pageCount - 1), { scroll: true, force: true });
      renderPages();
      await refreshObjects();
      renderDocList();
      toast('已撤销', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  };

  /* 拖拽打开 */
  document.addEventListener('dragover', (e) => { e.preventDefault(); });
  document.addEventListener('drop', async (e) => {
    e.preventDefault();
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (!f) return;
    // 拖图片进来 = 插入图片：和 Ctrl+V 走同一条路，用户不必先点工具再选文件
    if (/^image\//i.test(f.type)) {
      if (!S.doc) { toast('先打开或新建一个文档', 'err'); return; }
      const rec = await insertImageData(await fileToDataURL(f), f.name);
      if (rec) toast('图片已插入，拖四周手柄可调整大小', 'ok');
      return;
    }
    if (!f.name.toLowerCase().endsWith('.pdf')) return;
    const fd = new FormData();
    fd.append('file', f);
    try {
      const res = await fetch('/api/upload', { method: 'POST', body: fd });
      const j = await res.json();
      if (!j.ok) throw new Error(j.error.message);
      await loadInfo(j.data);
      toast('已打开 ' + f.name, 'ok');
    } catch (err) { toast(err.message, 'err'); }
  });

  /* ------------------------------------------------------------------ 检索 */
  async function doSearch() {
    if (!S.doc) return toast('没有打开的文档', 'err');
    const q = $('#q').value.trim();
    if (!q) return;
    showTab('results');
    $('#result-count').textContent = '检索中…';
    try {
      const r = await api('/api/search', { json: { query: q, force_ocr: S.forceOcr } });
      S.hits = r.hits;
      $('#result-count').textContent = `${r.total} 条命中` + (r.ocr_pages.length ? ` · OCR ${r.ocr_pages.length} 页` : '');
      renderResults();
      if (r.hits.length) await setCurrentPage(r.hits[0].page, { scroll: true });
      drawOverlay();
    } catch (e) {
      $('#result-count').textContent = '检索失败';
      toast(e.message, 'err');
    }
  }

  function renderResults() {
    const box = $('#results');
    if (!S.hits.length) {
      box.innerHTML = '<div class="empty-list">没有命中</div>';
      return;
    }
    box.innerHTML = '';
    S.hits.forEach((h) => {
      const el = document.createElement('div');
      el.className = 'obj';
      el.innerHTML = `<div class="row1"><span class="tag ${h.source === 'ocr' ? 'ocr' : ''}">${
        h.source === 'ocr' ? 'OCR' : '文本'
      }</span><span class="tag">第 ${h.page + 1} 页</span></div>
        <div class="txt">${esc(h.text)}</div>
        <div class="meta">${Math.round(h.bbox[0])},${Math.round(h.bbox[1])}  ·  ${esc(h.match)}</div>`;
      el.onclick = async () => {
        if (h.page !== S.page) await setCurrentPage(h.page, { scroll: true });
        S.sel = null;
        drawOverlay();
        const k = pxPerPt();
        const boxEl = currentBox();
        if (!boxEl) return;
        const targetTop = boxEl.offsetTop + h.bbox[1] * k - 120;
        const targetLeft = boxEl.offsetLeft + h.bbox[0] * k - 80;
        wrap.scrollTo({ top: Math.max(0, targetTop), left: Math.max(0, targetLeft), behavior: 'smooth' });
      };
      box.appendChild(el);
    });
  }

  $('#btn-search').onclick = doSearch;
  $('#q').addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });

  $('#btn-showtext').onclick = () => {
    S.showText = !S.showText;
    $('#btn-showtext').classList.toggle('active', S.showText);
    drawOverlay();
  };
  $('#btn-ocr').onclick = () => doOcrPage();
  const ocrTop = $('#btn-ocr-top');
  if (ocrTop) ocrTop.onclick = () => doOcrPage();
  // 检索时扫描件必须识别（用户主动发起，等得起），这个开关只管检索
  const ocrChk = $('#obj-ocr');
  if (ocrChk) ocrChk.onchange = (e) => { S.forceOcr = e.target.checked; };

  /* ------------------------------------------------------------------ 缩放 */
  /* 缩放时先只改盒子尺寸（立刻跟手），位图换高清版本防抖 160ms 再做。
     原来每次滚轮/点按都重建整个 DOM + 重新请求全部位图，连续缩放就是灾难。 */
  function applyZoomLayout() {
    // 这里必须用「新的理论比例」重排，不能调实测的 pxPerPt()：
    // 那个值量的是旧 box，zoom 刚变时还是旧比例，会把缩放卡住。
    pagesBox.querySelectorAll('.pbox').forEach((box) => sizeBox(+box.dataset.page, box));
    baseRect = null;
    drawOverlay();
  }

  let zoomTimer = 0;
  function setZoom(z) {
    const next = Math.max(0.3, Math.min(3, Math.round(z * 100) / 100));
    if (next === S.zoom) return;
    S.zoom = next;
    $('#zoom-label').textContent = Math.round(S.zoom * 100) + '%';
    if (!S.doc) return;
    applyZoomLayout();
    clearTimeout(zoomTimer);
    zoomTimer = setTimeout(() => {
      if (!S.doc) return;
      // 单页模式重排也没多少 DOM；连续/横向模式只换位图，不重建列表
      if (S.view === 'single') renderPages();
      else {
        pagesBox.querySelectorAll('.pbox').forEach((box) => reloadPageImage(+box.dataset.page));
      }
      drawOverlay();
    }, 160);
  }
  $('#zoom-in').onclick = () => setZoom(S.zoom + 0.15);
  $('#zoom-out').onclick = () => setZoom(S.zoom - 0.15);
  wrap.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    setZoom(S.zoom + (e.deltaY < 0 ? 0.1 : -0.1));
  }, { passive: false });

  /* ------------------------------------------------------------------ 标签页 */
  function showTab(name) {
    $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
    $$('.tabpane').forEach((p) => p.classList.toggle('active', p.id === 'pane-' + name));
  }
  $$('.tab').forEach((t) => (t.onclick = () => showTab(t.dataset.tab)));

  /* ------------------------------------------------------------------ 剪贴板 */
  /* Ctrl+V 粘贴图片，Ctrl+C 复制选中的图片/文字。
     两个来源都要接：
     1. 系统剪贴板（截图工具、浏览器里另存的图）—— 走 paste 事件；
     2. 应用内复制：写系统剪贴板失败时（非安全上下文 / 浏览器拒权），
        退到这块内存，Ctrl+V 仍然贴得出来。 */
  let clipImage = null;

  function clipboardImageFile(dt) {
    if (!dt) return null;
    for (const it of dt.items || []) {
      if (it.kind === 'file' && /^image\//i.test(it.type)) {
        const f = it.getAsFile();
        if (f) return f;
      }
    }
    for (const f of dt.files || []) {
      if (/^image\//i.test(f.type)) return f;
    }
    return null;
  }

  function clipboardHasText(dt) {
    if (!dt) return false;
    return Array.from(dt.types || []).some((t) => t === 'text/plain' || t === 'text/html');
  }

  function blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = reject;
      fr.readAsDataURL(blob);
    });
  }

  document.addEventListener('paste', async (e) => {
    // 弹窗里（比如改文字）粘贴走的还是文字，别抢
    if ($('#modal').classList.contains('show')) return;
    const inField = e.target && e.target.closest && e.target.closest('input, textarea');
    if (inField && clipboardHasText(e.clipboardData)) return;

    const f = clipboardImageFile(e.clipboardData);
    if (f) {
      e.preventDefault();
      if (!S.doc) { toast('先打开或新建一个文档', 'err'); return; }
      // 截图工具给的图常常没有正经文件名，给一个能在对象列表里认出来的名字
      const name = f.name && !/^image\.(png|jpe?g|gif|bmp|webp)$/i.test(f.name)
        ? f.name
        : `粘贴图片-${S.page + 1}.png`;
      const data = await fileToDataURL(f);
      const rec = await insertImageData(data, name);
      if (rec) {
        clipImage = null;
        toast('已粘贴图片，拖四周手柄可调整大小', 'ok');
      }
      return;
    }
    // 剪贴板里没有图：只有「刚在应用内复制过、系统剪贴板又没写成功」时才兜底。
    // 剪贴板里有文字就不插手 —— 那多半是用户刚复制了一段文字，不该冒出旧图。
    if (clipImage && !inField && !clipboardHasText(e.clipboardData)) {
      e.preventDefault();
      const c = clipImage;
      clipImage = null;
      if (!S.doc) { toast('先打开或新建一个文档', 'err'); return; }
      const rec = await insertImageData(c.data, c.name);
      if (rec) toast('已粘贴图片，拖四周手柄可调整大小', 'ok');
    }
  });

  async function copySelection() {
    const sel = S.sel;
    if (!sel) return false;
    if (sel.kind === 'text') {
      const text = sel.text || '';
      if (!text) return false;
      try {
        await navigator.clipboard.writeText(text);
        toast('已复制文字', 'ok');
      } catch (e) {
        toast('浏览器不允许写剪贴板，可改用属性面板里的文字框复制', 'err');
      }
      return true;
    }
    if (sel.kind !== 'image') return false;
    try {
      // 后端统一转成 PNG：剪贴板只可靠地接受 image/png，
      // 而 PDF 里的图可能是 JPEG/CMYK，原样塞进去会被浏览器拒掉。
      const url = `/api/image/raw?page=${S.page}&id=${encodeURIComponent(sel.id)}`
        + `&doc=${encodeURIComponent(S.doc || '')}`;
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error('取不到图片数据');
      const blob = await res.blob();
      clipImage = { data: await blobToDataURL(blob), name: sel.name || '复制的图片.png' };
      let sys = false;
      try {
        if (typeof ClipboardItem !== 'undefined' && navigator.clipboard && navigator.clipboard.write) {
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
          sys = true;
        }
      } catch (e) {
        sys = false;   // 没权限就只留在应用内，Ctrl+V 仍可用
      }
      toast(sys ? '已复制图片，到别处 Ctrl+V 也能贴' : '已复制图片，按 Ctrl+V 可粘贴', 'ok');
      return true;
    } catch (e) {
      toast('复制失败：' + e.message, 'err');
      return true;
    }
  }

  /* ------------------------------------------------------------------ 快捷键面板 */
  const SHORTCUTS = [
    {
      title: '文件',
      items: [
        ['新建空白文档', ['Ctrl', 'N']],
        ['打开 PDF', ['Ctrl', 'O']],
        ['保存', ['Ctrl', 'S']],
        ['撤销', ['Ctrl', 'Z']],
      ],
    },
    {
      title: '编辑',
      items: [
        ['复制选中的图片 / 文字', ['Ctrl', 'C']],
        ['粘贴剪贴板里的图片', ['Ctrl', 'V']],
        ['删除选中对象', ['Delete']],
        ['取消选中 / 收起本栏', ['Esc']],
      ],
    },
    {
      title: '工具',
      items: [
        ['选择 / 移动', ['V']],
        ['插入文本框', ['T']],
        ['画笔', ['P']],
        ['橡皮（只擦笔迹）', ['E']],
        ['插入图片（选文件）', ['I']],
        ['拖动页面', ['H']],
      ],
    },
    {
      title: '浏览',
      items: [
        ['上一页 / 下一页', ['PgUp', 'PgDn']],
        ['放大 / 缩小', ['Ctrl', '滚轮']],
        ['显示 / 收起对象面板', ['Ctrl', 'B']],
        ['打开 / 收起本栏', ['?']],
      ],
    },
  ];

  function renderKeys() {
    const box = $('#keys-body');
    if (!box || box.dataset.done === '1') return;
    box.dataset.done = '1';
    box.innerHTML = SHORTCUTS.map((g) => `
      <div class="ksec">
        <div class="ksec-head">${esc(g.title)}</div>
        ${g.items.map(([d, keys]) => `<div class="krow"><span class="kdesc">${esc(d)}</span>`
          + `<span class="kbd">${keys.map((k) => `<kbd>${esc(k)}</kbd>`).join('')}</span></div>`).join('')}
      </div>`).join('');
  }

  function keysOpen() {
    const l = $('.layout');
    return !!l && l.classList.contains('keys-open');
  }

  function setKeys(open) {
    const l = $('.layout');
    const panel = $('#keys-panel');
    if (!l || !panel) return;
    if (open) renderKeys();
    l.classList.toggle('keys-open', !!open);
    panel.classList.toggle('open', !!open);
    panel.setAttribute('aria-hidden', open ? 'false' : 'true');
    $('#btn-keys').classList.toggle('active', !!open);
    // 面板宽度变了，画布可用宽度跟着变：动画结束必须再画一次，
    // 否则 canvas 位图会被 CSS 拉伸，选框和笔迹一时对不上位置
    requestAnimationFrame(() => {
      drawOverlay();
      setTimeout(drawOverlay, 220);
    });
    try { localStorage.setItem('pdfx.keys', open ? '1' : '0'); } catch (e) { /* 隐私模式 */ }
  }

  $('#btn-keys').onclick = () => setKeys(!keysOpen());
  $('#keys-close').onclick = () => setKeys(false);

  /* ------------------------------------------------------------------ 右侧面板开合 */
  function inspOpen() {
    const l = $('.layout');
    return !!l && !l.classList.contains('insp-off');
  }

  function setInspector(open, persist = true) {
    const l = $('#layout') || $('.layout');
    const panel = $('#inspector');
    if (!l || !panel) return;
    const off = !open;
    l.classList.toggle('insp-off', off);
    panel.setAttribute('aria-hidden', off ? 'true' : 'false');
    // 三处入口保持同一状态：顶栏按钮、功能菜单、面板自己的收起按钮
    // （分割面板也占这一列，所以统一交给 syncPanelEntries 判断"这一列现在有没有面板"）
    syncPanelEntries();
    // 画布宽度变了：canvas 位图是 drawOverlay 按内容尺寸重设的，
    // 只靠 CSS 改宽度会被拉伸，选框与笔迹会错位（和展开快捷键侧栏同一处理）
    requestAnimationFrame(() => {
      baseRect = null;
      drawOverlay();
      setTimeout(drawOverlay, 220);
    });
    if (persist) {
      try { localStorage.setItem('pdfx.insp', off ? '0' : '1'); } catch (e) { /* 隐私模式 */ }
    }
  }

  /* 右侧面板的开关：分割面板开着时它是"收起分割、回到对象面板"。
     面板在的时候按钮永远算「展开中」，否则用户会以为点了没反应。 */
  function toggleRightPanel() {
    if (splitPanelOpen()) return closeSplitPanel();
    setInspector(!inspOpen());
  }
  $('#btn-inspector').onclick = toggleRightPanel;
  $('#btn-inspector-close').onclick = () => setInspector(false);
  $('#btn-inspector-menu').onclick = toggleRightPanel;

  /* ------------------------------------------------------------------ 快捷键 */
  document.addEventListener('keydown', (e) => {
    // 合成事件（测试脚本、扩展）的 target 可能是 document，没有 matches
    const tgt = e.target;
    if (tgt && tgt.matches && tgt.matches('input, textarea, select')) return;
    // 菜单开着时，除 Ctrl/Cmd 组合键外都交给菜单（Esc 收起、上下键选项）
    if (document.querySelector('.menu.open') && !(e.ctrlKey || e.metaKey)) return;
    const k = e.key.toLowerCase();
    if (e.ctrlKey || e.metaKey) {
      if (k === 's') { e.preventDefault(); doSave(); return; }
      if (k === 'n') { e.preventDefault(); newDocument(); return; }
      if (k === 'o') { e.preventDefault(); openFileDialog(); return; }
      if (k === 'b') { e.preventDefault(); toggleRightPanel(); return; }
      if (k === 'z') { e.preventDefault(); $('#btn-undo').click(); return; }
      // 没选中对象时不拦：留给浏览器默认的复制（选中页面文字等）
      if (k === 'c' && S.sel) { e.preventDefault(); copySelection(); return; }
      return;
    }
    // '?' 在中文输入法下不一定发得出来，F1 作为同一功能的备用键
    if (e.key === '?' || e.key === 'F1') { e.preventDefault(); setKeys(!keysOpen()); return; }
    if (k === 'v') setTool('select');
    if (k === 't') setTool('text');
    if (k === 'p') setTool('draw');
    if (k === 'e') setTool('erase');
    if (k === 'i') setTool('image');
    if (k === 'h') setTool('pan');
    if (e.key === 'PageDown') { e.preventDefault(); setCurrentPage(S.page + 1, { scroll: true }); }
    if (e.key === 'PageUp') { e.preventDefault(); setCurrentPage(S.page - 1, { scroll: true }); }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (deleteSelection(S.sel)) e.preventDefault();
    }
    if (e.key === 'Escape') {
      if (keysOpen()) { setKeys(false); return; }
      S.sel = null; drawOverlay(); renderObjList(); renderProps();
    }
  });

  window.addEventListener('resize', () => { baseRect = null; drawOverlay(); });
  /* 画布尺寸变了（展开侧栏、窗口缩放、面板折叠）都要重画叠加层：
     canvas 的内部像素尺寸是 drawOverlay 自己设的，只靠 CSS 改宽度会被拉伸变形。
     同时让指针几何缓存失效 —— 侧栏一展开，页面整体横移，旧 rect 会让
     手势中后续的采样点全偏到旁边。 */
  if (typeof ResizeObserver !== 'undefined') {
    let roTimer = 0;
    new ResizeObserver(() => {
      clearTimeout(roTimer);
      roTimer = setTimeout(() => { baseRect = null; drawOverlay(); }, 60);
    }).observe(wrap);
  }

  /* ------------------------------------------------------------------ 启动 */
  /* 前后端版本握手：前端是静态文件，刷新即新版；后端不会。
     如果 8765 上还挂着旧进程，新参数会静默失效，用户只会觉得"改了没用"。 */
  async function checkServerCaps() {
    try {
      const r = await fetch('/api/caps');
      const j = await r.json();
      const caps = (j && j.data && j.data.caps) || [];
      // 缺任何一项新能力都算旧服务端：新前端会调到它没有的接口，用户只会觉得"点了没反应"
      // erase.guarded = /api/erase 已要求显式 allow_content，旧服务端会直接擦掉正文
      const need = ['text.transform', 'canvas.layered', 'erase.guarded', 'ocr.optional',
        'bitmap.cached', 'image.clipboard', 'split.batch'];
      if (!j.ok || need.some((k) => !caps.includes(k))) {
        throw new Error('stale');
      }
    } catch (e) {
      const bar = $('#stale-bar');
      if (bar) bar.hidden = false;
    }
  }

  (async function boot() {
    syncStageClass();
    checkServerCaps();
    // 上次开着就还开着：这是"随时想看"的辅助面板，不该每次刷新都重开一遍
    try { if (localStorage.getItem('pdfx.keys') === '1') setKeys(true); } catch (e) { /* 隐私模式 */ }
    // 右侧面板同理：只有明确收起过才收起，第一次用默认展开（否则新用户会以为没有属性面板）
    // 无条件走一遍 setInspector，是为了把顶栏按钮 / 菜单项的勾选态和真实状态对齐
    try { setInspector(localStorage.getItem('pdfx.insp') !== '0', false); } catch (e) { /* 隐私模式 */ }
    try {
      const info = await api('/api/doc');
      await loadInfo(info);
      const h = new URLSearchParams(location.hash.replace(/^#/, ''));
      const q = h.get('q');
      const pg = parseInt(h.get('page') || '', 10);
      if (pg > 0) await setCurrentPage(pg - 1, { scroll: true });
      if (q) {
        $('#q').value = q;
        await doSearch();
      }
    } catch (e) {
      renderEmpty();
      await refreshDocList();
    }
  })();
})();
