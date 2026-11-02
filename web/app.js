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
    version: 0,           // 内容版本号，用于图片缓存失效
    brush: { color: '#d64545', width: 2.2 },
    eraser: { radius: 10, scope: 'all' },   // all=笔迹+页面原有内容；ink=只擦自己画的笔迹
    textStyle: { size: 12, color: '#111111' },
  };

  const wrap = $('#stage-wrap');
  const pagesBox = $('#pages');
  const pxPerPt = () => S.zoom * PX_PER_PT;

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
  function dialog({ title, html, okText = '确定', cancelText = '取消', onMount }) {
    return new Promise((resolve) => {
      const back = $('#modal');
      $('#modal-title').textContent = title;
      $('#modal-body').innerHTML = html;
      const foot = $('#modal-foot');
      foot.innerHTML = '';
      if (cancelText) {
        const b = document.createElement('button');
        b.className = 'btn';
        b.textContent = cancelText;
        b.onclick = () => close(null);
        foot.appendChild(b);
      }
      if (okText) {
        const b = document.createElement('button');
        b.className = 'btn primary';
        b.textContent = okText;
        b.onclick = () => close(collect());
        foot.appendChild(b);
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
      if (onMount) onMount(body, close, collect);
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
      el.onchange = () => resolve(el.files[0] || null);
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
    const dpi = Math.max(60, Math.round(96 * S.zoom));
    return `/api/page/${i}.png?dpi=${dpi}&doc=${S.doc}&v=${S.version}`;
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

  function renderPages() {
    io.disconnect();
    pagesBox.innerHTML = '';
    if (!S.doc || !S.pageCount) {
      renderEmpty();
      return;
    }
    const list = S.view === 'single' ? [S.page] : Array.from({ length: S.pageCount }, (_, i) => i);
    const k = pxPerPt();
    list.forEach((i) => {
      const [w, h] = sizeOf(i);
      const box = document.createElement('div');
      box.className = 'pbox' + (i === S.page ? ' current' : '');
      box.dataset.page = i;
      box.style.width = Math.max(1, Math.round(w * k)) + 'px';
      box.style.height = Math.max(1, Math.round(h * k)) + 'px';

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

  function renderThumbs() {
    const box = $('#thumbs');
    box.innerHTML = '';
    $('#page-count').textContent = String(S.pageCount);
    $('#page-now').textContent = String(S.pageCount ? S.page + 1 : 0);
    if (!S.doc || !S.pageCount) return;
    for (let i = 0; i < S.pageCount; i++) {
      const w = document.createElement('div');
      w.className = 'thumb-wrap' + (i === S.page ? ' active' : '');
      w.dataset.page = i;
      const b = document.createElement('button');
      b.className = 'thumb';
      b.title = `第 ${i + 1} 页`;
      b.innerHTML = `<img src="/api/page/${i}/thumb.png?w=150&doc=${S.doc}&v=${S.version}" alt="" loading="lazy" />`;
      b.onclick = () => setCurrentPage(i, { scroll: true });
      const num = document.createElement('div');
      num.className = 'num';
      num.textContent = String(i + 1);
      w.append(b, num);
      box.appendChild(w);
    }
  }

  function reloadThumb(i) {
    const im = $(`#thumbs .thumb-wrap[data-page="${i}"] img`);
    if (im) im.src = `/api/page/${i}/thumb.png?w=150&doc=${S.doc}&v=${S.version}`;
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
    S.doc = info.doc_id || info.doc || S.doc;
    S.path = info.path || null;
    if (!info.pages) {
      try { info = await api('/api/doc'); S.path = info.path || null; } catch (e) { /* ignore */ }
    }
    S.pageCount = info.page_count || (info.pages ? info.pages.length : 0);
    S.sizes = (info.pages || []).map((p) => p.size || S.size);
    S.page = 0;
    S.sel = null;
    S.hits = [];
    S.version++;
    syncStageClass();
    // 先列文档（左侧栏先有内容），再渲染页面，观感上不会"空一下"
    await refreshDocList();
    await renderThumbs();
    renderPages();
    await refreshObjects();
    renderProps();
    updateOcrBadge(info.ocr);
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
  async function refreshObjects() {
    if (!S.doc) return;
    try {
      const objs = await api(`/api/page/${S.page}/objects?ocr=${S.forceOcr ? 1 : 0}`);
      S.objs = { texts: objs.texts.items, images: objs.images.items, strokes: objs.strokes.items };
      S.size = objs.size;
      S.sizes[S.page] = objs.size;
      S.type = objs.type;
      $('#page-type').textContent = { text: '结构化文本', scanned: '扫描件', mixed: '混合', empty: '空白页' }[objs.type] || objs.type;
      // 注意类名要加前缀：直接写 'pill empty' 会和页面上的空状态遮罩 .empty 撞名
      $('#page-type').className = 'pill t-' + objs.type;
      drawOverlay();
      renderObjList();
      if (S.hits.length) renderResults();
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  /* 兼容旧调用名 */
  const refreshPage = async () => { await refreshObjects(); };

  function rectOf(b) {
    const k = pxPerPt();
    return [b[0] * k, b[1] * k, (b[2] - b[0]) * k, (b[3] - b[1]) * k];
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
    const w = cvs.clientWidth || 1;
    const h = cvs.clientHeight || 1;
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

    // 移动 / 缩放的实时预览
    if (S.drag && S.drag.cur) {
      const [x, y, ww, hh] = rectOf(S.drag.cur);
      ctx.strokeStyle = S.drag.kind === 'resize' ? '#7c3aed' : '#1f6feb';
      ctx.lineWidth = 1.6;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(x, y, ww, hh);
      ctx.setLineDash([]);
      ctx.fillStyle = S.drag.kind === 'resize' ? 'rgba(124,58,237,.07)' : 'rgba(31,111,235,.06)';
      ctx.fillRect(x, y, ww, hh);
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

    if (!rows.length) {
      box.innerHTML = '<div class="empty-list">本页没有可编辑对象</div>';
      return;
    }
    box.innerHTML = '';
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
        <div class="hint" id="p-hint"></div>
        <div class="actions">
          <button class="btn primary" id="p-apply">应用修改</button>
          <button class="btn danger" id="p-del">删除</button>
        </div>`;
      const hex = $('#p-color-hex');
      $('#p-color').oninput = (e) => (hex.value = e.target.value);
      hex.oninput = (e) => { if (/^#[0-9a-f]{6}$/i.test(e.target.value)) $('#p-color').value = e.target.value; };
      $('#p-hint').textContent = (o.source === 'ocr'
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

  /* 内容变了：刷新对象 + 缩略图，页面位图按需更新 */
  async function afterContentChange(opts = {}) {
    const { pageImage = true } = opts;
    S.version++;
    await refreshObjects();
    reloadThumb(S.page);
    if (pageImage) reloadPageImage(S.page);
    renderDocList();
  }

  async function applyTextEdit(o) {
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
      await api('/api/image', { method: 'DELETE', json: { page: S.page, id: o.id } });
      S.sel = null;
      await afterContentChange();
      toast('已删除图片', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  }

  /* ------------------------------------------------------------------ 画布交互 */
  /* pointerdown 时缓存一次 rect：pointermove 里每帧都调 getBoundingClientRect()
     会强制浏览器同步布局，是画笔"一卡一卡"的典型原因。 */
  let baseRect = null;

  function toPdf(ev, box) {
    const b = box || currentBox();
    if (!b) return [0, 0];
    const r = baseRect || b.getBoundingClientRect();
    return [(ev.clientX - r.left) / pxPerPt(), (ev.clientY - r.top) / pxPerPt()];
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
    return [cx / pxPerPt(), cy / pxPerPt()];
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
    baseRect = box.getBoundingClientRect();
    try { ev.target.setPointerCapture?.(ev.pointerId); } catch (e) { /* 合成事件没有真实 pointerId */ }
    const pt = toPdf(ev, box);

    if (S.tool === 'select') {
      // 1) 手柄优先：选中状态下四角四边都能拖
      const hIdx = hitHandle(pt, S.sel && S.sel.bbox);
      if (hIdx != null) {
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
      S.erasing = { points: [pt], radius: S.eraser.radius, scope: S.eraser.scope };
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
        await api('/api/ink', { json: { page: S.page, strokes: [{ points: d.points, color: d.color, width: d.width }] } });
        const objs = await api(`/api/page/${S.page}/objects?ocr=0`);
        S.objs.strokes = objs.strokes.items;
        paint('both');
        renderObjList();
        reloadThumb(S.page);
      } catch (e) {
        S.objs.strokes = S.objs.strokes.filter((x) => x.id !== tmp.id);
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
        let cut = { removed: 0 };
        let area = null;
        if (e0.scope === 'all') {
          // 服务端一次搞定：擦页面内容 + 断开覆盖区内的笔迹
          area = await api('/api/erase', {
            json: { page: S.page, points: e0.points, radius: e0.radius },
          });
          cut = { removed: area.strokes_removed || 0 };
        } else if ((S.objs.strokes || []).length) {
          cut = await api('/api/ink/erase', {
            json: { page: S.page, points: e0.points, radius: e0.radius, mode: 'cut' },
          });
        }
        // 页面位图必须重拉：擦掉的是页面本身的内容，不是画布上的覆盖层
        await afterContentChange();
        const bits = [];
        if (cut.removed) bits.push(`笔迹 ${cut.removed} 处`);
        if (area && area.removed_text_count) bits.push(`文字 ${area.removed_text_count} 处`);
        if (area && area.covered) bits.push('内容已涂掉');
        toast(bits.length ? '已擦除：' + bits.join(' · ') : '这里没有可擦除的内容', bits.length ? 'ok' : '');
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
      await placeText(rect);
      return;
    }

    if (S.drag) {
      const d = S.drag;
      S.drag = null;
      if (d.moved) await commitDrag(d);
      else { paint('both'); }
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
  async function placeText(rect) {
    const text = await askText('', '输入要插入的文字');
    if (!text || !text.trim()) return;
    try {
      const rec = await api('/api/text', {
        json: { page: S.page, text, rect, font_size: S.textStyle.size, color: S.textStyle.color },
      });
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

  async function insertImageNow() {
    const f = await pickFile('image');
    if (!f) return;
    const data = await fileToDataURL(f);
    const dim = await imageSizeOf(data);
    const [pw, ph] = sizeOf(S.page);
    // 像素按 96dpi 换成 pt，太大就缩到页面宽度的 55%
    let w = Math.min((dim.w * 72) / 96, pw * 0.55);
    let h = w * (dim.h / Math.max(1, dim.w));
    if (h > ph * 0.6) { h = ph * 0.6; w = h * (dim.w / Math.max(1, dim.h)); }
    const c = viewCenterPt();
    const rect = clampBbox([c[0] - w / 2, c[1] - h / 2, c[0] + w / 2, c[1] + h / 2]);
    try {
      const rec = await api('/api/image', {
        json: { page: S.page, rect, data_url: data, name: f.name },
      });
      await afterContentChange();
      if (rec) {
        S.sel = { kind: 'image', ...rec, source: 'user' };
        renderObjList();
        renderProps();
        showTab('props');
      }
      setTool('select');
      toast('图片已插入，拖四周手柄可调整大小', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  }

  /* 移动 / 缩放的提交：松手才落库，过程中只在画布上预览 */
  async function commitDrag(d) {
    const o = d.obj;
    if (!o) { paint('both'); return; }
    // 只有文本和图片支持变换，别的类型直接放弃预览
    if (o.kind !== 'text' && o.kind !== 'image') { paint('both'); return; }
    const rect = d.cur;
    if (d.kind === 'move'
      && Math.abs(rect[0] - d.start[0]) < 0.4
      && Math.abs(rect[1] - d.start[1]) < 0.4) {
      paint('both');
      return;
    }
    try {
      let res;
      if (o.kind === 'text') {
        res = await api('/api/text', {
          method: 'PUT',
          json: {
            page: S.page, id: o.id, rect,
            font_size: d.kind === 'resize' ? d.fontSize : (o.size || undefined),
          },
        });
      } else {
        res = await api('/api/image', {
          method: 'PUT',
          json: { page: S.page, id: o.id, rect, keep_ratio: d.kind === 'resize' ? d.keep : true },
        });
      }
      await afterContentChange();
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
      paint('both');
      renderObjList();
      renderProps();
      toast(d.kind === 'move' ? '已移动' : '已调整大小', 'ok');
    } catch (e) {
      toast(e.message, 'err');
      await afterContentChange();
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
      bar.innerHTML = `<span>擦除范围</span>
        <select id="era-scope">
          <option value="all"${S.eraser.scope === 'all' ? ' selected' : ''}>笔迹 + 页面内容</option>
          <option value="ink"${S.eraser.scope === 'ink' ? ' selected' : ''}>只擦我的笔迹</option>
        </select>
        <span>橡皮大小</span><input type="range" id="era-size" min="3" max="60" step="1" value="${S.eraser.radius}" />
        <span class="val" id="era-val">${S.eraser.radius}</span>
        <span class="hint" style="margin:0" id="era-hint">${S.eraser.scope === 'all'
          ? '拖过要擦的地方：笔迹与页面内容一起擦（Ctrl+Z 可撤销）'
          : '只擦自己画的笔迹，页面原有内容不动'}</span>`;
      $('#era-scope').onchange = (e) => {
        S.eraser.scope = e.target.value;
        renderFloatbar();
      };
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
      S.version++;
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
      S.version++;
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
        const box = el.querySelector('#browser');
        async function nav(p) {
          try {
            const r = await api('/api/browse' + (p ? '?dir=' + encodeURIComponent(p) : ''));
            box.innerHTML = `<div class="path">${esc(r.dir)}</div>`;
            const up = document.createElement('div');
            up.className = 'item';
            up.textContent = '↑ 上级目录';
            up.onclick = () => nav(r.parent);
            box.appendChild(up);
            r.items.forEach((it) => {
              if (it.dir || it.pdf) {
                const row = document.createElement('div');
                row.className = 'item' + (it.pdf ? ' isfile' : '');
                row.innerHTML = `<span>${it.dir ? '📁' : '📄'} ${esc(it.name)}</span><span class="sz">${it.dir ? '' : fmtSize(it.size)}</span>`;
                row.onclick = () => {
                  if (it.dir) nav(it.path);
                  else el.querySelector('#f-path').value = it.path;
                };
                box.appendChild(row);
              }
            });
          } catch (e) {
            box.innerHTML = `<div class="path">${esc(e.message)}</div>`;
          }
        }
        nav(startDir || '');
      },
    });
  }

  $('#btn-open').onclick = () => openFileDialog();

  async function openFileDialog() {
    const r = await browseDialog({ title: '打开 PDF', okText: '打开' });
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
    const picked = await browseDialog({ title: '插入 PDF —— 选择文件', okText: '下一步' });
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
      S.version++;
      S.pageCount = r.page_count;
      S.sizes = (r.pages || []).map((p) => p.size || S.size);
      await renderThumbs();
      await setCurrentPage((r.imported && r.imported[0]) || S.page, { scroll: true });
      renderPages();
      renderDocList();
      toast(`已插入 ${r.imported_count} 页`, 'ok');
    } catch (e) { toast(e.message, 'err'); }
  };

  /* ---- 保存 ---- */
  async function defaultSavePath() {
    let dir = '';
    try {
      const r = await api('/api/browse');
      dir = r.dir || '';
    } catch (e) { dir = ''; }
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
    const sep = dir.includes('\\') ? '\\' : '/';
    return dir ? `${dir}${sep}未命名-${stamp}.pdf` : `未命名-${stamp}.pdf`;
  }

  async function saveAs() {
    const def = await defaultSavePath();
    const r = await dialog({
      title: '保存新文档',
      okText: '保存到该路径',
      html: `
        <div class="field"><label>保存路径（可修改）</label>
          <input type="text" data-field="path" id="s-path" value="${esc(def)}" /></div>
        <div class="browser" id="s-browser"><div class="path">加载中…</div></div>
        <div class="hint">这是一份<b>新建文档</b>，还没有保存到磁盘。确认上面的完整路径后点「保存到该路径」。</div>`,
      onMount: async (el) => {
        const box = el.querySelector('#s-browser');
        const input = el.querySelector('#s-path');
        let dir = '';
        async function nav(p) {
          try {
            const rr = await api('/api/browse' + (p ? '?dir=' + encodeURIComponent(p) : ''));
            dir = rr.dir;
            // 切目录时保留文件名，只换目录
            const name = baseName(input.value) || '未命名.pdf';
            const sep = dir.includes('\\') ? '\\' : '/';
            input.value = dir + sep + name;
            box.innerHTML = `<div class="path">${esc(rr.dir)}</div>`;
            const up = document.createElement('div');
            up.className = 'item';
            up.textContent = '↑ 上级目录';
            up.onclick = () => nav(rr.parent);
            box.appendChild(up);
            rr.items.filter((it) => it.dir).forEach((it) => {
              const row = document.createElement('div');
              row.className = 'item';
              row.innerHTML = `<span>📁 ${esc(it.name)}</span>`;
              row.onclick = () => nav(it.path);
              box.appendChild(row);
            });
          } catch (e) {
            box.innerHTML = `<div class="path">${esc(e.message)}</div>`;
          }
        }
        nav('');
      },
    });
    if (!r || !r.path) return null;
    if (!/\.pdf$/i.test(r.path)) r.path += '.pdf';
    try {
      const res = await api('/api/save', { json: { path: r.path, as_current: true } });
      S.path = res.path;
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
      S.version++;
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
    if (!f || !f.name.toLowerCase().endsWith('.pdf')) return;
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
  $('#obj-ocr').onchange = (e) => { S.forceOcr = e.target.checked; refreshObjects(); };

  /* ------------------------------------------------------------------ 缩放 */
  function setZoom(z) {
    S.zoom = Math.max(0.3, Math.min(3, z));
    $('#zoom-label').textContent = Math.round(S.zoom * 100) + '%';
    if (S.doc) renderPages();
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

  /* ------------------------------------------------------------------ 快捷键 */
  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea, select')) return;
    const k = e.key.toLowerCase();
    if (e.ctrlKey || e.metaKey) {
      if (k === 's') { e.preventDefault(); doSave(); }
      if (k === 'z') { e.preventDefault(); $('#btn-undo').click(); }
      return;
    }
    if (k === 'v') setTool('select');
    if (k === 't') setTool('text');
    if (k === 'p') setTool('draw');
    if (k === 'e') setTool('erase');
    if (k === 'i') setTool('image');
    if (k === 'h') setTool('pan');
    if (e.key === 'PageDown') { e.preventDefault(); setCurrentPage(S.page + 1, { scroll: true }); }
    if (e.key === 'PageUp') { e.preventDefault(); setCurrentPage(S.page - 1, { scroll: true }); }
    if (e.key === 'Delete' && S.sel) {
      if (S.sel.kind === 'text') deleteText(S.sel);
      else if (S.sel.kind === 'image') deleteImage(S.sel);
    }
    if (e.key === 'Escape') { S.sel = null; drawOverlay(); renderObjList(); renderProps(); }
  });

  window.addEventListener('resize', () => { drawOverlay(); });

  /* ------------------------------------------------------------------ 启动 */
  /* 前后端版本握手：前端是静态文件，刷新即新版；后端不会。
     如果 8765 上还挂着旧进程，新参数会静默失效，用户只会觉得"改了没用"。 */
  async function checkServerCaps() {
    try {
      const r = await fetch('/api/caps');
      const j = await r.json();
      const caps = (j && j.data && j.data.caps) || [];
      // 缺任何一项新能力都算旧服务端：新前端会调到它没有的接口，用户只会觉得"点了没反应"
      const need = ['text.transform', 'canvas.layered', 'erase.content'];
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
