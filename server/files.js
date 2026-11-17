// What files the chat accepts, decided from the file's real bytes (not its name or the browser's claim).
// SVG, HTML, scripts, executables and archives are never accepted.

const TYPES = [
  { mime: 'image/jpeg', kind: 'image', ext: 'jpg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/png', kind: 'image', ext: 'png', test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: 'image/gif', kind: 'image', ext: 'gif', test: (b) => b.subarray(0, 4).toString('latin1') === 'GIF8' },
  { mime: 'image/webp', kind: 'image', ext: 'webp', test: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
  { mime: 'image/heic', kind: 'file', ext: 'heic', test: (b) => b.subarray(4, 8).toString('latin1') === 'ftyp' && /^(heic|heix|hevc|mif1|msf1)$/.test(b.subarray(8, 12).toString('latin1')) },
  { mime: 'video/mp4', kind: 'file', ext: 'mp4', test: (b) => b.subarray(4, 8).toString('latin1') === 'ftyp' && /^(isom|iso2|mp41|mp42|avc1|M4V |dash)$/.test(b.subarray(8, 12).toString('latin1')) },
  { mime: 'video/quicktime', kind: 'file', ext: 'mov', test: (b) => b.subarray(4, 8).toString('latin1') === 'ftyp' && b.subarray(8, 12).toString('latin1') === 'qt  ' },
  { mime: 'application/pdf', kind: 'file', ext: 'pdf', test: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-' },
];
const OFFICE = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
const TEXT = { txt: 'text/plain; charset=utf-8', csv: 'text/csv; charset=utf-8' };

export const ACCEPT = 'image/jpeg,image/png,image/gif,image/webp,image/heic,.heic,application/pdf,.docx,.xlsx,.pptx,.txt,.csv,video/mp4,video/quicktime';

export function sniff(buf, filename) {
  if (!Buffer.isBuffer(buf) || buf.length < 4) return null;
  const ext = (String(filename).toLowerCase().match(/\.([a-z0-9]{1,5})$/) || [])[1] || '';
  for (const t of TYPES) if (t.test(buf)) return { mime: t.mime, kind: t.kind, ext: t.ext };
  // Office files are ZIP containers: accept only with a matching extension and the right inner folder.
  if (buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04 && OFFICE[ext]) {
    const head = buf.subarray(0, Math.min(buf.length, 64 * 1024)).toString('latin1');
    const folder = { docx: 'word/', xlsx: 'xl/', pptx: 'ppt/' }[ext];
    if (head.includes('[Content_Types].xml') || head.includes(folder)) return { mime: OFFICE[ext], kind: 'file', ext };
    return null;
  }
  // Plain text / CSV: must be valid UTF-8 with no binary bytes.
  if (TEXT[ext]) {
    if (buf.includes(0)) return null;
    try { new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { return null; }
    return { mime: TEXT[ext], kind: 'file', ext };
  }
  return null;
}

// Safe display name: no paths, no control or bidi characters, sensible length, extension matching the real type.
export function safeFileName(name, ext) {
  let n = String(name || '').split(/[\\/]/).pop() || '';
  n = n.normalize('NFC').replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\u200e\u200f]/g, '').replace(/\s+/g, ' ').trim();
  n = n.replace(/\.[a-z0-9]{1,5}$/i, '');
  if (!n) n = 'file';
  return `${n.slice(0, 100)}.${ext}`;
}
