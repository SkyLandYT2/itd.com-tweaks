function computeCoverScale(imgW, imgH, vpW, vpH) {
  return Math.max(vpW / imgW, vpH / imgH);
}

function clampPosition(x, y, imgW, imgH, scale, vpW, vpH) {
  const scaledW = imgW * scale;
  const scaledH = imgH * scale;
  const minX = vpW - scaledW;
  const minY = vpH - scaledH;
  return {
    x: Math.min(0, Math.max(minX, x)),
    y: Math.min(0, Math.max(minY, y)),
  };
}

function computeZoomedPosition(oldX, oldY, oldScale, newScale, cursorX, cursorY) {
  const factor = newScale / oldScale;
  return {
    x: cursorX - (cursorX - oldX) * factor,
    y: cursorY - (cursorY - oldY) * factor,
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { computeCoverScale, clampPosition, computeZoomedPosition };
}

const JWT_REGEX = /^eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isJwt(s) { return typeof s === 'string' && JWT_REGEX.test(s); }
function isUuid(s) { return typeof s === 'string' && UUID_REGEX.test(s); }

function* walkStrings(obj, maxDepth, depth) {
  if (maxDepth === undefined) maxDepth = 2;
  if (depth === undefined) depth = 0;
  if (depth > maxDepth) return;
  if (typeof obj === 'string') { yield obj; return; }
  if (obj && typeof obj === 'object') {
    for (const v of Object.values(obj)) yield* walkStrings(v, maxDepth, depth + 1);
  }
}

function searchStorage(storage) {
  let token = null, deviceId = null;
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    const raw = storage.getItem(key);
    if (raw == null) continue;

    if (!token && isJwt(raw)) { token = raw; if (deviceId) break; continue; }
    if (!deviceId && isUuid(raw)) { deviceId = raw; if (token) break; continue; }

    let parsed;
    try { parsed = JSON.parse(raw); } catch (_) { continue; }
    for (const s of walkStrings(parsed)) {
      if (!token && isJwt(s)) token = s;
      else if (!deviceId && isUuid(s)) deviceId = s;
      if (token && deviceId) break;
    }
    if (token && deviceId) break;
  }
  return { token, deviceId };
}

function isJwtExpired(jwt) {
  if (typeof jwt !== 'string') return true;
  const parts = jwt.split('.');
  if (parts.length !== 3) return true;
  let payload;
  try {
    let b = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    while (b.length % 4) b += '=';
    const json = typeof atob !== 'undefined' ? atob(b) : Buffer.from(b, 'base64').toString('binary');
    payload = JSON.parse(json);
  } catch (_) { return true; }
  if (typeof payload.exp !== 'number') return false;
  return payload.exp * 1000 < Date.now() + 5000;
}

function parseCookies(cookieString) {
  if (!cookieString) return [];
  const pairs = cookieString.split(';');
  const result = [];
  for (const pair of pairs) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const name = trimmed.slice(0, eq).trim();
    const rawValue = trimmed.slice(eq + 1).trim();
    let value;
    try { value = decodeURIComponent(rawValue); } catch (_) { value = rawValue; }
    result.push({ name, value });
  }
  return result;
}

function searchCookies(cookieString) {
  let token = null, deviceId = null;
  for (const { value } of parseCookies(cookieString)) {
    if (!token && isJwt(value)) { token = value; }
    else if (!deviceId && isUuid(value)) { deviceId = value; }
    if (token && deviceId) break;
  }
  return { token, deviceId };
}

function searchWindow(obj) {
  let token = null, deviceId = null;
  const seen = new WeakSet();
  function visit(v, depth) {
    if (depth > 3) return;
    if (token && deviceId) return;
    if (typeof v === 'string') {
      if (!token && isJwt(v)) token = v;
      else if (!deviceId && isUuid(v)) deviceId = v;
      return;
    }
    if (!v || typeof v !== 'object') return;
    if (seen.has(v)) return;
    seen.add(v);
    let keys;
    try { keys = Object.keys(v); } catch (_) { return; }
    for (const k of keys) {
      if (token && deviceId) return;
      let next;
      try { next = v[k]; } catch (_) { continue; }
      visit(next, depth + 1);
    }
  }
  visit(obj, 0);
  return { token, deviceId };
}

function searchAllSources() {
  const merged = { token: null, deviceId: null };
  function merge(found) {
    if (found.token && !merged.token) merged.token = found.token;
    if (found.deviceId && !merged.deviceId) merged.deviceId = found.deviceId;
  }
  try { merge(searchStorage(localStorage)); } catch (_) {}
  if (merged.token && merged.deviceId) return merged;
  try { merge(searchStorage(sessionStorage)); } catch (_) {}
  if (merged.token && merged.deviceId) return merged;
  try { merge(searchCookies(document.cookie)); } catch (_) {}
  if (merged.token && merged.deviceId) return merged;
  try { merge(searchWindow(window)); } catch (_) {}
  return merged;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { isJwt, isUuid, walkStrings, searchStorage, isJwtExpired, parseCookies, searchCookies, searchWindow, searchAllSources };
}

const OVERLAY_ROOT_ID = 'itd-banner-uploader-root';

function el(tag, styles, attrs) {
  const node = document.createElement(tag);
  if (styles) for (const k in styles) node.style[k] = styles[k];
  if (attrs) for (const k in attrs) node.setAttribute(k, attrs[k]);
  return node;
}

function mountOverlay(opts) {
  // opts: { initialState, onPickFile(file), onUpload(), onCancel(), onCredsInput(token, deviceId) }

  // Удаляем существующий оверлей
  const existing = document.getElementById(OVERLAY_ROOT_ID);
  if (existing) {
    if (existing._api && typeof existing._api.unmount === 'function') {
      try { existing._api.unmount(); } catch (_) {}
    } else {
      existing.remove();
    }
  }

  const root = el('div', { all: 'initial' }, { id: OVERLAY_ROOT_ID });
  root.style.cssText = [
    'position:fixed', 'inset:0', 'z-index:2147483647',
    'background:rgba(0,0,0,0.75)', 'display:flex',
    'align-items:center', 'justify-content:center',
    'font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif',
    'color:#fff', 'font-size:14px', 'line-height:1.4',
  ].join(';');

  const card = el('div');
  card.style.cssText = [
    'background:#1a1a1a', 'border:1px solid #333', 'border-radius:8px',
    'padding:20px', 'min-width:400px', 'max-width:calc(100vw - 40px)',
    'box-shadow:0 20px 60px rgba(0,0,0,0.5)', 'display:flex',
    'flex-direction:column', 'gap:12px',
  ].join(';');

  const header = el('div');
  header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;font-size:16px;font-weight:600';
  const title = el('span'); title.textContent = 'Загрузка баннера ITD';
  const closeBtn = el('button');
  closeBtn.textContent = '×';
  closeBtn.style.cssText = 'background:transparent;border:none;color:#fff;font-size:24px;cursor:pointer;line-height:1;padding:0 8px';
  header.append(title, closeBtn);

  const body = el('div');
  body.style.cssText = 'display:flex;flex-direction:column;gap:12px';

  const status = el('div');
  status.style.cssText = 'min-height:20px;font-size:13px;color:#aaa';

  card.append(header, body, status);
  root.append(card);
  document.body.appendChild(root);

  // Машина состояний
  let currentState = null;
  let isUploading = false;

  function setStatus(text, kind) {
    status.textContent = text || '';
    status.style.color = kind === 'error' ? '#ff6b6b' : kind === 'success' ? '#51cf66' : '#aaa';
  }

  function clearBody() { while (body.firstChild) body.removeChild(body.firstChild); }

  function renderAuthInput() {
    clearBody();
    const note = el('div');
    note.innerHTML = 'Не нашёл токен автоматически. Открой DevTools → Application → Local Storage на итд.com и найди значения, похожие на JWT и UUID.';
    note.style.cssText = 'font-size:13px;color:#ccc';

    function inputStyle() {
      return 'padding:8px;background:#0e0e0e;border:1px solid #444;border-radius:4px;color:#fff;font-family:monospace;font-size:12px';
    }
    function errStyle() {
      return 'font-size:11px;color:#ff6b6b;min-height:14px;margin-top:-4px';
    }

    const tokInput = el('input', null, { placeholder: 'Bearer JWT (eyJ...)' });
    tokInput.style.cssText = inputStyle();
    const tokErr = el('div'); tokErr.style.cssText = errStyle();

    const devInput = el('input', null, { placeholder: 'X-Device-Id (UUID)' });
    devInput.style.cssText = inputStyle();
    const devErr = el('div'); devErr.style.cssText = errStyle();

    const submit = el('button');
    submit.textContent = 'Продолжить';
    submit.style.cssText = btnPrimary();
    submit.disabled = true;
    submit.style.opacity = '0.5';
    submit.style.cursor = 'not-allowed';

    function validate() {
      const t = tokInput.value.trim();
      const d = devInput.value.trim();
      const tokShape = !t || isJwt(t);
      const devShape = !d || isUuid(d);
      const tokFresh = !t || !isJwt(t) || !isJwtExpired(t);

      tokInput.style.borderColor = (t && (!tokShape || !tokFresh)) ? '#ff6b6b' : '#444';
      devInput.style.borderColor = (d && !devShape) ? '#ff6b6b' : '#444';

      tokErr.textContent = !tokShape ? 'не похоже на JWT (должен начинаться с eyJ, 3 секции через точку)'
                       : !tokFresh ? 'токен истёк — нужен свежий из DevTools'
                       : '';
      devErr.textContent = !devShape ? 'не похоже на UUID' : '';

      const ok = t && d && tokShape && devShape && tokFresh;
      submit.disabled = !ok;
      submit.style.opacity = ok ? '1' : '0.5';
      submit.style.cursor = ok ? 'pointer' : 'not-allowed';
    }

    tokInput.addEventListener('input', validate);
    devInput.addEventListener('input', validate);
    validate();

    submit.addEventListener('click', () => {
      if (submit.disabled) return;
      opts.onCredsInput(tokInput.value.trim(), devInput.value.trim());
    });

    const captureHint = el('div');
    captureHint.textContent = 'Или просто покликай по странице итд.com — поймаю токен из фонового запроса автоматически.';
    captureHint.style.cssText = 'font-size:12px;color:#888;margin-top:8px';

    const credit = el('div');
    credit.style.cssText = 'font-size:11px;color:#666;margin-top:4px';
    const creditLink = el('a', null, { href: 'https://github.com/SkyLandYT2/itd.com-tweaks/tree/main', target: '_blank', rel: 'noopener' });
    creditLink.textContent = 'https://github.com/SkyLandYT2/itd.com-tweaks';
    creditLink.style.cssText = 'color:#888;text-decoration:underline';
    credit.append(document.createTextNode('создано человеком SkyLandYT2 — '), creditLink);

    body.append(note, tokInput, tokErr, devInput, devErr, submit, captureHint, credit);
  }

  function renderIdle() {
    clearBody();
    const drop = el('div');
    drop.textContent = 'Перетащи картинку сюда или кликни';
    drop.style.cssText = [
      'border:2px dashed #555', 'border-radius:8px', 'padding:60px 20px',
      'text-align:center', 'cursor:pointer', 'color:#888', 'background:#0e0e0e',
    ].join(';');

    const fileInput = el('input', null, { type: 'file', accept: 'image/*' });
    fileInput.style.cssText = 'display:none';

    drop.addEventListener('click', () => fileInput.click());
    drop.addEventListener('dragover', e => { e.preventDefault(); drop.style.borderColor = '#888'; });
    drop.addEventListener('dragleave', () => { drop.style.borderColor = '#555'; });
    drop.addEventListener('drop', e => {
      e.preventDefault();
      drop.style.borderColor = '#555';
      const f = e.dataTransfer.files[0];
      if (f) opts.onPickFile(f);
    });
    fileInput.addEventListener('change', () => {
      const f = fileInput.files[0];
      if (f) opts.onPickFile(f);
    });

    body.append(drop, fileInput);
  }

  function renderCropping(viewport) {
    clearBody();
    const hint = el('div');
    hint.textContent = 'Перетащи мышью · колесо для зума';
    hint.style.cssText = 'font-size:12px;color:#888';

    const controls = el('div');
    controls.style.cssText = 'display:flex;gap:8px;justify-content:flex-end';
    const resetBtn = el('button'); resetBtn.textContent = 'Сбросить'; resetBtn.style.cssText = btnSecondary();
    const cancelBtn = el('button'); cancelBtn.textContent = 'Отмена'; cancelBtn.style.cssText = btnSecondary();
    const uploadBtn = el('button'); uploadBtn.textContent = 'Загрузить'; uploadBtn.style.cssText = btnPrimary();

    resetBtn.addEventListener('click', () => api.cropperReset && api.cropperReset());
    cancelBtn.addEventListener('click', () => { if (!isUploading) opts.onCancel(); });
    uploadBtn.addEventListener('click', () => { if (!isUploading) opts.onUpload(); });

    controls.append(resetBtn, cancelBtn, uploadBtn);

    body.append(viewport, hint, controls);
    api._uploadBtn = uploadBtn;
    api._cancelBtn = cancelBtn;
    api._resetBtn = resetBtn;
  }

  function btnPrimary() {
    return 'padding:8px 16px;background:#4dabf7;color:#000;border:none;border-radius:4px;cursor:pointer;font-weight:600';
  }
  function btnSecondary() {
    return 'padding:8px 16px;background:#333;color:#fff;border:1px solid #555;border-radius:4px;cursor:pointer';
  }

  // Обработчики закрытия
  function tryClose() {
    if (isUploading) return;
    api.unmount();
    opts.onCancel();
  }
  closeBtn.addEventListener('click', tryClose);
  root.addEventListener('click', e => { if (e.target === root) tryClose(); });
  const escHandler = e => { if (e.key === 'Escape') tryClose(); };
  document.addEventListener('keydown', escHandler);

  const api = {
    unmount() {
      if (typeof opts.onUnmount === 'function') {
        try { opts.onUnmount(); } catch (_) {}
      }
      document.removeEventListener('keydown', escHandler);
      root.remove();
    },
    setState(state, payload) {
      currentState = state;
      if (state === 'auth-input') renderAuthInput();
      else if (state === 'idle') renderIdle();
      else if (state === 'cropping') renderCropping(payload);
      else if (state === 'uploading') {
        isUploading = true;
        if (api._uploadBtn) { api._uploadBtn.textContent = 'Загружаю…'; api._uploadBtn.disabled = true; api._uploadBtn.style.opacity = '0.6'; }
        if (api._cancelBtn) api._cancelBtn.disabled = true;
        if (api._resetBtn) api._resetBtn.disabled = true;
        setStatus('Отправка…', '');
      }
      else if (state === 'done') {
        isUploading = false;
        setStatus('Готово — обнови страницу профиля', 'success');
        setTimeout(() => api.unmount(), 3000);
      }
      else if (state === 'error') {
        isUploading = false;
        if (api._uploadBtn) { api._uploadBtn.textContent = 'Загрузить'; api._uploadBtn.disabled = false; api._uploadBtn.style.opacity = '1'; }
        if (api._cancelBtn) api._cancelBtn.disabled = false;
        if (api._resetBtn) api._resetBtn.disabled = false;
        setStatus(payload || 'Ошибка', 'error');
      }
    },
    setCropperResetFn(fn) { api.cropperReset = fn; },
    getState() { return currentState; },
  };

  root._api = api;
  return api;
}

function Cropper(image, vpW, vpH) {
  // Строим элемент вьюпорта с масштабированием под размер экрана
  const visualScale = Math.min(
    1,
    (window.innerWidth - 80) / vpW,
    (window.innerHeight - 220) / vpH
  );

  const wrap = document.createElement('div');
  wrap.style.cssText = [
    `width:${vpW * visualScale}px`,
    `height:${vpH * visualScale}px`,
    'overflow:hidden', 'position:relative', 'background:#000',
    'border:1px solid #444', 'border-radius:4px', 'cursor:grab',
    'user-select:none', 'touch-action:none',
  ].join(';');

  const inner = document.createElement('div');
  inner.style.cssText = [
    `width:${vpW}px`, `height:${vpH}px`,
    `transform:scale(${visualScale})`, 'transform-origin:top left',
    'position:relative', 'overflow:hidden',
  ].join(';');

  const img = document.createElement('img');
  img.src = image.src;
  img.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none;transform-origin:top left';
  img.draggable = false;

  inner.appendChild(img);
  wrap.appendChild(inner);

  // Состояние
  const imgW = image.naturalWidth;
  const imgH = image.naturalHeight;
  const minScale = computeCoverScale(imgW, imgH, vpW, vpH);
  const maxScale = minScale * 4;
  let scale = minScale;
  let x = (vpW - imgW * scale) / 2;
  let y = (vpH - imgH * scale) / 2;

  function applyTransform() {
    img.style.width = imgW + 'px';
    img.style.height = imgH + 'px';
    img.style.transform = `translate(${x}px,${y}px) scale(${scale})`;
  }
  applyTransform();

  // Перетаскивание
  let dragging = false, startCX, startCY, startImgX, startImgY;
  wrap.addEventListener('pointerdown', e => {
    dragging = true;
    wrap.setPointerCapture(e.pointerId);
    wrap.style.cursor = 'grabbing';
    startCX = e.clientX; startCY = e.clientY;
    startImgX = x; startImgY = y;
  });
  wrap.addEventListener('pointermove', e => {
    if (!dragging) return;
    const dx = (e.clientX - startCX) / visualScale;
    const dy = (e.clientY - startCY) / visualScale;
    const clamped = clampPosition(startImgX + dx, startImgY + dy, imgW, imgH, scale, vpW, vpH);
    x = clamped.x; y = clamped.y;
    applyTransform();
  });
  wrap.addEventListener('pointerup', e => {
    dragging = false;
    wrap.style.cursor = 'grab';
    try { wrap.releasePointerCapture(e.pointerId); } catch (_) {}
  });
  wrap.addEventListener('pointercancel', () => { dragging = false; wrap.style.cursor = 'grab'; });

  // Зум колесом мыши
  wrap.addEventListener('wheel', e => {
    e.preventDefault();
    const rect = wrap.getBoundingClientRect();
    const cursorX = (e.clientX - rect.left) / visualScale;
    const cursorY = (e.clientY - rect.top) / visualScale;
    const newScale = Math.max(minScale, Math.min(maxScale, scale * (1 - e.deltaY * 0.001)));
    if (newScale === scale) return;
    const next = computeZoomedPosition(x, y, scale, newScale, cursorX, cursorY);
    scale = newScale;
    const clamped = clampPosition(next.x, next.y, imgW, imgH, scale, vpW, vpH);
    x = clamped.x; y = clamped.y;
    applyTransform();
  }, { passive: false });

  return {
    element: wrap,
    reset() {
      scale = minScale;
      x = (vpW - imgW * scale) / 2;
      y = (vpH - imgH * scale) / 2;
      applyTransform();
    },
    getCanvas() {
      const canvas = document.createElement('canvas');
      canvas.width = vpW;
      canvas.height = vpH;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, vpW, vpH);
      ctx.drawImage(image, 0, 0, imgW, imgH, x, y, imgW * scale, imgH * scale);
      return canvas;
    },
  };
}

function upload(blob, creds) {
  const fd = new FormData();
  fd.append('file', blob, 'banner.png');
  return fetch('/api/files/upload', {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Authorization': 'Bearer ' + creds.token,
      'X-Device-Id': creds.deviceId,
      'Accept': '*/*',
      'X-Requested-With': 'XMLHttpRequest',
    },
    body: fd,
  });
}

function setBanner(bannerId, creds) {
  return fetch('/api/users/me', {
    method: 'PUT',
    credentials: 'include',
    headers: {
      'Authorization': 'Bearer ' + creds.token,
      'X-Device-Id': creds.deviceId,
      'Accept': '*/*',
      'X-Requested-With': 'XMLHttpRequest',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ bannerId: bannerId }),
  });
}

(function () {
  const HOSTNAME = 'xn--d1ah4a.com';
  if (location.hostname !== HOSTNAME && location.hostname !== 'итд.com') {
    alert('Открой итд.com сначала — букмарклет работает только там.');
    return;
  }

  let _origFetch = null;
  let _origSetHeader = null;
  let _interceptCb = null;

  function installInterceptor(onCreds) {
    if (_origFetch) return;
    _origFetch = window.fetch;
    _origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
    _interceptCb = onCreds;

    window.fetch = function (input, init) {
      try {
        const headers = init && init.headers;
        if (headers) {
          const h = new Headers(headers);
          const a = h.get('authorization');
          const d = h.get('x-device-id');
          const found = {};
          if (a && a.toLowerCase().startsWith('bearer ')) found.token = a.slice(7);
          if (d) found.deviceId = d;
          if ((found.token || found.deviceId) && _interceptCb) _interceptCb(found);
        }
      } catch (_) {}
      return _origFetch.apply(this, arguments);
    };

    XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
      try {
        const n = String(name).toLowerCase();
        if (n === 'authorization' && typeof value === 'string' && value.toLowerCase().startsWith('bearer ') && _interceptCb) {
          _interceptCb({ token: value.slice(7) });
        } else if (n === 'x-device-id' && _interceptCb) {
          _interceptCb({ deviceId: value });
        }
      } catch (_) {}
      return _origSetHeader.apply(this, arguments);
    };
  }

  function uninstallInterceptor() {
    if (!_origFetch) return;
    window.fetch = _origFetch;
    XMLHttpRequest.prototype.setRequestHeader = _origSetHeader;
    _origFetch = null;
    _origSetHeader = null;
    _interceptCb = null;
  }

  let currentCreds = null;
  let currentImage = null;
  let currentCropper = null;
  let ui = null;

  function startWithCreds(creds) {
    currentCreds = creds;
    ui.setState('idle');
  }

  function onPickFile(file) {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      currentImage = img;
      currentCropper = Cropper(img, 985, 340);
      ui.setCropperResetFn(() => currentCropper.reset());
      ui.setState('cropping', currentCropper.element);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      ui.setState('error', 'Не удалось открыть файл');
    };
    img.src = url;
  }

  function extractBannerId(obj) {
    if (!obj || typeof obj !== 'object') return null;
    for (const key of ['bannerId', 'id', 'fileId', 'uuid']) {
      if (isUuid(obj[key])) return obj[key];
    }
    for (const s of walkStrings(obj)) {
      if (isUuid(s)) return s;
    }
    return null;
  }

  function onUpload() {
    if (!currentCropper || !currentCreds) return;
    if (isJwtExpired(currentCreds.token)) {
      ui.setState('error', 'JWT истёк за время работы. Закрой оверлей и попробуй снова — токен подхватится автоматически.');
      return;
    }
    ui.setState('uploading');
    currentCropper.getCanvas().toBlob(async blob => {
      if (!blob) {
        ui.setState('error', 'Не удалось создать изображение');
        return;
      }
      try {
        const uploadResp = await upload(blob, currentCreds);
        if (!uploadResp.ok) {
          let body = '';
          try { body = await uploadResp.text(); } catch (_) {}
          ui.setState('error', `Upload HTTP ${uploadResp.status}: ${body.slice(0, 200)}`);
          return;
        }
        let uploadJson;
        try { uploadJson = await uploadResp.json(); } catch (_) {
          ui.setState('error', 'Не смог распарсить ответ /api/files/upload');
          return;
        }
        const bannerId = extractBannerId(uploadJson);
        if (!bannerId) {
          ui.setState('error', `Нет UUID в ответе: ${JSON.stringify(uploadJson).slice(0, 200)}`);
          return;
        }
        const setResp = await setBanner(bannerId, currentCreds);
        if (!setResp.ok) {
          let body = '';
          try { body = await setResp.text(); } catch (_) {}
          ui.setState('error', `Set HTTP ${setResp.status}: ${body.slice(0, 200)}`);
          return;
        }
        ui.setState('done');
      } catch (err) {
        ui.setState('error', err.message || String(err));
      }
    }, 'image/png');
  }

  function onCancel() {
    if (currentImage && currentImage.src.startsWith('blob:')) URL.revokeObjectURL(currentImage.src);
    currentImage = null;
    currentCropper = null;
    // Не перерисовываем, если оверлей уже закрыт (кнопка закрытия / Esc / клик по фону).
    if (ui && document.getElementById('itd-banner-uploader-root')) ui.setState('idle');
  }

  function onCredsInput(token, deviceId) {
    startWithCreds({ token, deviceId });
  }

  function onInterceptedCreds(found) {
    if (found.token) {
      currentCreds = currentCreds || { token: null, deviceId: null };
      currentCreds.token = found.token;
    }
    if (found.deviceId && !(currentCreds && currentCreds.deviceId)) {
      currentCreds = currentCreds || { token: null, deviceId: null };
      currentCreds.deviceId = found.deviceId;
    }
    if (currentCreds && currentCreds.token && currentCreds.deviceId && !isJwtExpired(currentCreds.token)) {
      if (ui && ui.getState() === 'auth-input') {
        ui.setState('idle');
      }
    }
  }

  installInterceptor(onInterceptedCreds);

  ui = mountOverlay({
    onPickFile,
    onUpload,
    onCancel,
    onCredsInput,
    onUnmount: uninstallInterceptor,
  });

  const detected = searchAllSources();
  if (detected.token && detected.deviceId && !isJwtExpired(detected.token)) {
    startWithCreds(detected);
  } else {
    currentCreds = (detected.token || detected.deviceId) ? detected : null;
    ui.setState('auth-input');
  }
})();
