// Shared by the visitor chat and the team inbox: preparing, uploading and showing file attachments.
// Files go to the server (which checks them) and are stored privately in Supabase Storage. They are shown
// through short-lived private links that the server hands out only to people in the conversation.

const MB = 1024 * 1024;

function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null) n.append(c);
  return n;
}

export const fmtSize = (b) => (b >= MB ? `${(b / MB).toFixed(b >= 10 * MB ? 0 : 1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

// Phone photos are often 3–8 MB. Shrink big JPEGs to a sharp 2400px version (usually under 1 MB):
// faster to send on mobile data and far less storage used.
export async function prepareFile(file, maxMb) {
  if (file.type === 'image/jpeg' && file.size > 1.5 * MB && 'createImageBitmap' in window) {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
      const scale = Math.min(1, 2400 / Math.max(bmp.width, bmp.height));
      const w = Math.round(bmp.width * scale); const h = Math.round(bmp.height * scale);
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
      bmp.close?.();
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.86));
      if (blob && blob.size < file.size) file = new File([blob], file.name.replace(/\.(jpe?g)$/i, '') + '.jpg', { type: 'image/jpeg' });
    } catch { /* send the original */ }
  }
  if (file.size > maxMb * MB) throw new Error(`That file is ${fmtSize(file.size)}. Files can be up to ${maxMb} MB.`);
  if (!file.size) throw new Error('That file is empty.');
  return file;
}

// XHR (not fetch) so we can show upload progress.
export function uploadFile({ file, headers, onProgress }) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/files');
    for (const [k, v] of Object.entries(headers)) if (v) xhr.setRequestHeader(k, v);
    xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name || 'file'));
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(e.loaded / e.total); };
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
      if (xhr.status >= 200 && xhr.status < 300 && data.message) resolve(data.message);
      else reject(new Error(data.error || 'Upload failed. Please try again.'));
    };
    xhr.onerror = () => reject(new Error('Upload failed. Check your connection and try again.'));
    xhr.ontimeout = () => reject(new Error('Upload timed out. Please try again.'));
    xhr.timeout = 120_000;
    xhr.send(file);
  });
}

// Private links expire after ~30 minutes; cache them and ask again when needed.
export function makeUrlCache(request) {
  const cache = new Map();
  return async function getUrl(id, { fresh = false } = {}) {
    const hit = cache.get(id);
    if (!fresh && hit && hit.expiresAt > Date.now()) return hit.url;
    const res = await request(id);
    if (!res?.url) throw new Error(res?.error || 'Could not open the file.');
    cache.set(id, { url: res.url, expiresAt: res.expiresAt });
    return res.url;
  };
}

const FILE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M14 3H6v18h12V7l-4-4z"/><path d="M14 3v4h4"/></svg>';
function icon(markup) { const t = document.createElement('template'); t.innerHTML = markup; return t.content.firstChild; }
const extOf = (name) => ((name || '').match(/\.([a-z0-9]{1,5})$/i) || [])[1]?.toUpperCase() || 'FILE';

// The bubble content for an attachment message.
export function attachmentNode(att, getUrl) {
  const isImage = att.kind === 'image';
  const link = el('a', { class: `lc-att ${isImage ? 'lc-att-img is-loading' : 'lc-att-file'}`, target: '_blank', rel: 'noopener noreferrer', 'aria-label': `${isImage ? 'Open image' : 'Download'} ${att.name}` });
  if (isImage) {
    const img = el('img', { alt: att.name, decoding: 'async', loading: 'lazy' });
    img.addEventListener('load', () => link.classList.remove('is-loading'));
    img.addEventListener('error', () => { link.classList.remove('is-loading'); link.classList.add('is-broken'); link.replaceChildren(el('span', { class: 'lc-att-broken', text: `Image unavailable · ${att.name}` })); });
    link.append(img);
    getUrl(att.id).then((u) => { img.src = u; link.href = u; }).catch(() => img.dispatchEvent(new Event('error')));
  } else {
    link.append(
      el('span', { class: 'lc-att-icon' }, icon(FILE_ICON), el('b', { text: extOf(att.name) })),
      el('span', { class: 'lc-att-meta' }, el('strong', { text: att.name }), el('small', { text: `${fmtSize(att.size)} · Download` })));
    getUrl(att.id).then((u) => { link.href = u; }).catch(() => {});
  }
  // Links expire: refresh on click if needed.
  link.addEventListener('click', async (e) => {
    if (link.classList.contains('is-broken')) { e.preventDefault(); return; }
    try {
      const u = await getUrl(att.id);
      if (u !== link.href) { e.preventDefault(); link.href = u; window.open(u, '_blank', 'noopener'); }
    } catch { e.preventDefault(); }
  });
  return link;
}

// The in-progress bubble while uploading.
export function uploadingNode(name) {
  const bar = el('i');
  const node = el('div', { class: 'lc-uploading' },
    el('span', { class: 'lc-att-icon' }, icon(FILE_ICON), el('b', { text: extOf(name) })),
    el('span', { class: 'lc-att-meta' }, el('strong', { text: name }), el('small', { text: 'Uploading…' }), el('span', { class: 'lc-progress' }, bar)));
  node.setProgress = (p) => { bar.style.transform = `scaleX(${Math.max(0.03, Math.min(1, p))})`; };
  return node;
}

// Paste (screenshots) and drag-and-drop onto an element.
export function wireFileInputs({ dropZone, pasteTarget, onFiles, enabled }) {
  pasteTarget.addEventListener('paste', (e) => {
    if (!enabled()) return;
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) { e.preventDefault(); onFiles(files); }
  });
  let depth = 0;
  dropZone.addEventListener('dragenter', (e) => { if (!enabled() || !e.dataTransfer?.types?.includes('Files')) return; e.preventDefault(); depth++; dropZone.classList.add('is-dropping'); });
  dropZone.addEventListener('dragover', (e) => { if (!enabled() || !e.dataTransfer?.types?.includes('Files')) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  dropZone.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) dropZone.classList.remove('is-dropping'); });
  dropZone.addEventListener('drop', (e) => {
    depth = 0; dropZone.classList.remove('is-dropping');
    if (!enabled()) return;
    const files = [...(e.dataTransfer?.files || [])];
    if (files.length) { e.preventDefault(); onFiles(files); }
  });
}

export const ICON_CLIP = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11.5l-8.6 8.6a5.5 5.5 0 0 1-7.8-7.8l8.9-8.9a3.7 3.7 0 0 1 5.2 5.2l-8.9 8.9a1.8 1.8 0 0 1-2.6-2.6l8.3-8.3"/></svg>';
export { icon as svgIcon };
