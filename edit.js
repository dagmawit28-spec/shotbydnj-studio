// ShotByDNJ Studio — real editing engine (runs entirely on this device, plus Claude for the edit plan).
// Pipeline: ingest -> analyze (shake / blur / hands-on-lens / frozen / loudness) -> transcribe (on-device Whisper)
//           -> music beats + ducking -> Claude plans the cut (sees frames + transcript) -> you approve
//           -> WebGL house-look grade -> real-time render to MP4/WebM -> finished library + big screens.

const H = () => window.__hq;
const $ = (sel, root = document) => root.querySelector(sel);
const esc = x => String(x ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const fmt = s => { s = Math.max(0, s); const m = Math.floor(s / 60); return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`; };

export const LOOKS = {
  clean: { contrast: 0.10, sat: 1.04, warm: 0.01, lift: 0.015, roll: 0.04, sh: [0, 0, 0], hi: [0, 0, 0], grain: 0.02 },
  moody: { contrast: 0.18, sat: 0.88, warm: -0.01, lift: 0.04, roll: 0.08, sh: [-0.01, 0.005, 0.02], hi: [0.015, 0.008, -0.01], grain: 0.035 },
  warm: { contrast: 0.12, sat: 1.02, warm: 0.035, lift: 0.025, roll: 0.06, sh: [0.01, 0, -0.01], hi: [0.02, 0.01, -0.015], grain: 0.03 },
};
const FORMATS = {
  reel: { label: 'Reel 9:16', w: 1080, h: 1920, bars: 0 },
  film: { label: 'Film 16:9 with 2.39 bars', w: 1920, h: 1080, bars: (1 - (1920 / 2.39) / 1080) / 2 },
  square: { label: 'Feed 4:5', w: 1080, h: 1350, bars: 0 },
};
const MUTE_DEFAULT = /\bn[i1!]gg(?:a|er|ah|uh|as|ers|az)\b/i;

/* ------------------------------------------------------------------ storage (finished library) */
const dbp = new Promise(res => { try { const r = indexedDB.open('sbdnj-edits', 2); r.onupgradeneeded = () => { const d = r.result; for (const n of ['finished', 'presets', 'methods']) if (!d.objectStoreNames.contains(n)) d.createObjectStore(n, { keyPath: 'id' }); }; r.onsuccess = () => res(r.result); r.onerror = () => res(null); } catch { res(null); } });
async function putIn(store, item) { const db = await dbp; if (!db) return; await new Promise(r => { const tx = db.transaction(store, 'readwrite'); tx.objectStore(store).put(item); tx.oncomplete = r; tx.onerror = r; }); }
async function allIn(store) { const db = await dbp; if (!db) return []; return new Promise(r => { const out = []; const tx = db.transaction(store, 'readonly'); const c = tx.objectStore(store).openCursor(); c.onsuccess = () => { const cur = c.result; if (cur) { out.push(cur.value); cur.continue(); } else r(out.sort((a, b) => b.at - a.at)); }; c.onerror = () => r(out); }); }
async function delIn(store, id) { const db = await dbp; if (!db) return; await new Promise(r => { const tx = db.transaction(store, 'readwrite'); tx.objectStore(store).delete(id); tx.oncomplete = r; tx.onerror = r; }); }
async function saveFinished(item) { const db = await dbp; if (!db) return; await new Promise(r => { const tx = db.transaction('finished', 'readwrite'); tx.objectStore('finished').put(item); tx.oncomplete = r; tx.onerror = r; }); }
async function listFinished() { const db = await dbp; if (!db) return []; return new Promise(r => { const out = []; const tx = db.transaction('finished', 'readonly'); const c = tx.objectStore('finished').openCursor(); c.onsuccess = () => { const cur = c.result; if (cur) { out.push(cur.value); cur.continue(); } else r(out.sort((a, b) => b.at - a.at)); }; c.onerror = () => r(out); }); }
async function deleteFinished(id) { const db = await dbp; if (!db) return; await new Promise(r => { const tx = db.transaction('finished', 'readwrite'); tx.objectStore('finished').delete(id); tx.oncomplete = r; tx.onerror = r; }); }

/* ------------------------------------------------------------------ crew hooks */
function crew(id, text, ms = 600000) { const p = H()?.PEOPLE?.find(x => x.id === id); if (!p) return; p.real = text; p.realUntil = performance.now() + ms; }
function crewDone(ids) { for (const id of ids) { const p = H()?.PEOPLE?.find(x => x.id === id); if (p) p.realUntil = 0; } }
function say(html) { H()?.log?.(html, true); }

/* ------------------------------------------------------------------ media helpers */
function videoEl(url) { const v = document.createElement('video'); v.src = url; v.preload = 'auto'; v.playsInline = true; v.setAttribute('playsinline', ''); v.crossOrigin = 'anonymous'; return v; }
const once = (el, ev) => new Promise(r => el.addEventListener(ev, r, { once: true }));
async function seek(v, t) { if (Math.abs(v.currentTime - t) < 0.02 && v.readyState >= 2) return; const p = once(v, 'seeked'); v.currentTime = t; await Promise.race([p, sleep(3000)]); }
async function loadMeta(v) { if (v.readyState >= 1) return; await Promise.race([once(v, 'loadedmetadata'), sleep(15000)]); }

/* ------------------------------------------------------------------ presets: LUTs (.cube), Lightroom (.xmp), methods */
let PRESETS = [], METHODS = [];
const NEUTRAL = { contrast: 0, sat: 1, warm: 0, lift: 0, roll: 0, sh: [0, 0, 0], hi: [0, 0, 0], grain: 0.015 };
function parseCube(text) {
  let N = 0, dmin = [0, 0, 0], dmax = [1, 1, 1]; const vals = [];
  for (const line of text.split(/\r?\n/)) { const l = line.trim(); if (!l || l[0] === '#') continue;
    if (/^LUT_3D_SIZE/i.test(l)) N = +l.split(/\s+/)[1]; else if (/^DOMAIN_MIN/i.test(l)) dmin = l.split(/\s+/).slice(1).map(Number); else if (/^DOMAIN_MAX/i.test(l)) dmax = l.split(/\s+/).slice(1).map(Number);
    else if (/^[-\d.]/.test(l)) { const p = l.split(/\s+/).map(Number); if (p.length >= 3 && p.every(Number.isFinite)) vals.push(p[0], p[1], p[2]); } }
  if (!N || vals.length < N * N * N * 3) throw new Error('That .cube file is not a 3D LUT this editor can read.');
  const data = new Uint8Array(N * N * N * 4);
  for (let i = 0; i < N * N * N; i++) { for (let k = 0; k < 3; k++) data[i * 4 + k] = Math.round(clamp((vals[i * 3 + k] - dmin[k]) / ((dmax[k] - dmin[k]) || 1), 0, 1) * 255); data[i * 4 + 3] = 255; }
  return { N, data };
}
function parseXMP(text) {
  const get = (k, d = 0) => { const m = text.match(new RegExp('crs:' + k + '="([^"]*)"')) || text.match(new RegExp('<crs:' + k + '>([^<]*)</crs:' + k + '>')); const v = m ? parseFloat(m[1]) : NaN; return Number.isFinite(v) ? v : d; };
  const exp = get('Exposure2012', get('Exposure', 0)), con = get('Contrast2012', get('Contrast', 0)), hi = get('Highlights2012', 0), sh = get('Shadows2012', 0), wh = get('Whites2012', 0), bl = get('Blacks2012', 0);
  const it = get('IncrementalTemperature', NaN), ta = get('Temperature', NaN), vib = get('Vibrance', 0), sat = get('Saturation', 0), grain = get('GrainAmount', 0);
  const warm = Number.isFinite(it) ? it / 100 * 0.06 : Number.isFinite(ta) ? (ta - 5500) / 5000 * 0.05 : 0;
  const hueRGB = (h, s) => { const a = h / 360 * 2 * Math.PI; return [Math.cos(a), Math.cos(a - 2.094), Math.cos(a + 2.094)].map(v => v * s / 100 * 0.035); };
  return { contrast: clamp(con / 100 * 0.3, -0.2, 0.35), sat: clamp(1 + (sat + vib * 0.6) / 100 * 0.6, 0.2, 1.6), warm: clamp(warm, -0.08, 0.08), lift: clamp(sh / 100 * 0.05 - bl / 100 * 0.04, -0.06, 0.1), roll: clamp(-hi / 100 * 0.2 - wh / 100 * 0.05, -0.1, 0.3),
    sh: hueRGB(get('SplitToningShadowHue', get('ColorGradeShadowHue', 0)), get('SplitToningShadowSaturation', get('ColorGradeShadowSat', 0))), hi: hueRGB(get('SplitToningHighlightHue', get('ColorGradeHighlightHue', 0)), get('SplitToningHighlightSaturation', get('ColorGradeHighlightSat', 0))),
    grain: clamp(grain / 100 * 0.07, 0, 0.08), expo: Math.pow(2, clamp(exp, -3, 3)) };
}
function safeLook(l) { const n = (v, a, b, d) => Number.isFinite(+v) ? clamp(+v, a, b) : d; const v3 = (x) => Array.isArray(x) && x.length === 3 ? x.map(y => n(y, -0.03, 0.03, 0)) : [0, 0, 0];
  return { contrast: n(l?.contrast, -0.2, 0.35, 0.1), sat: n(l?.sat, 0.2, 1.6, 1), warm: n(l?.warm, -0.08, 0.08, 0), lift: n(l?.lift, -0.06, 0.1, 0.02), roll: n(l?.roll, -0.1, 0.3, 0.05), sh: v3(l?.sh), hi: v3(l?.hi), grain: n(l?.grain, 0, 0.08, 0.02) }; }
function kindOf(name) { const e = (name.split('.').pop() || '').toLowerCase(); if (e === 'cube') return 'lut'; if (e === 'xmp') return 'xmp'; if (['ttf', 'otf', 'woff', 'woff2'].includes(e)) return 'font'; if (['mp3', 'wav', 'm4a', 'aif', 'aiff', 'ogg'].includes(e)) return 'audio'; if (['mp4', 'mov', 'webm', 'm4v'].includes(e)) return 'video'; if (['png', 'jpg', 'jpeg', 'heic', 'webp', 'gif'].includes(e)) return 'image'; if (['drx', 'prfpset', 'lrtemplate', 'dng', 'look', 'acv', '3dl', 'mogrt', 'prproj', 'drp', 'zip'].includes(e)) return 'project'; return 'other'; }
const KIND_LABEL = { lut: 'LUT', xmp: 'Lightroom', font: 'Font', audio: 'Sound', video: 'Overlay / video', image: 'Image', project: 'Preset / project', other: 'File' };
function lookOptions() { return [['moody', 'Moody (house)'], ['clean', 'Clean (house)'], ['warm', 'Warm (house)'], ...PRESETS.filter(p => p.kind === 'lut').map(p => ['lut:' + p.id, 'LUT · ' + p.name]), ...PRESETS.filter(p => p.kind === 'xmp').map(p => ['xmp:' + p.id, 'Preset · ' + p.name]), ...METHODS.filter(m => m.look).map(m => ['method:' + m.id, 'Method · ' + m.title])]; }
async function resolveLook(key) {
  if (LOOKS[key]) return { look: LOOKS[key], lut: null, expo: 1, name: key };
  const [kind, id] = String(key).split(':');
  try {
    if (kind === 'lut') { const p = PRESETS.find(x => x.id === id); return { look: { ...NEUTRAL, contrast: 0.02, lift: 0.005 }, lut: parseCube(await p.blob.text()), expo: 1, name: p.name }; }
    if (kind === 'xmp') { const p = PRESETS.find(x => x.id === id); const x = parseXMP(await p.blob.text()); return { look: x, lut: null, expo: x.expo, name: p.name }; }
    if (kind === 'method') { const m = METHODS.find(x => x.id === id); return { look: safeLook(m.look), lut: null, expo: 1, name: m.title }; }
  } catch (e) { console.warn('preset failed', e); }
  return { look: LOOKS.moody, lut: null, expo: 1, name: 'moody' };
}
async function loadLibrary() { PRESETS = await allIn('presets'); METHODS = await allIn('methods'); }
const lookFileTag = k => String(k).replace(/[^\w]+/g, '-').slice(0, 24);

function defaultLook() { try { return localStorage.getItem('sbdnj-default-look') || 'moody'; } catch { return 'moody'; } }
/* ------------------------------------------------------------------ 1. analysis */
async function analyzeClip(clip, onStep) {
  const v = videoEl(clip.url); v.muted = true; await loadMeta(v);
  clip.duration = v.duration || 0; clip.w = v.videoWidth; clip.h = v.videoHeight;
  const W = 96, Hh = Math.max(32, Math.round(96 * (clip.h / clip.w || 0.5625)));
  const c = document.createElement('canvas'); c.width = W; c.height = Hh; const g = c.getContext('2d', { willReadFrequently: true });
  const tc = document.createElement('canvas'); tc.width = 320; tc.height = Math.round(320 * Hh / W); const tg = tc.getContext('2d');
  const step = clip.duration > 240 ? 1 : 0.5; const samples = []; let prev = null; clip.thumbs = [];
  for (let t = 0.05; t < clip.duration - 0.05; t += step) {
    await seek(v, t); g.drawImage(v, 0, 0, W, Hh); const d = g.getImageData(0, 0, W, Hh).data;
    const lum = new Float32Array(W * Hh); let sum = 0;
    for (let i = 0; i < W * Hh; i++) { const y = (0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]) / 255; lum[i] = y; sum += y; }
    const mean = sum / lum.length; let vs = 0, lap = 0, motion = 0, dark = 0;
    for (let i = 0; i < lum.length; i++) { vs += (lum[i] - mean) ** 2; if (lum[i] < 0.1) dark++; }
    for (let y = 1; y < Hh - 1; y++) for (let x = 1; x < W - 1; x++) { const i = y * W + x; lap += Math.abs(4 * lum[i] - lum[i - 1] - lum[i + 1] - lum[i - W] - lum[i + W]); }
    if (prev) { for (let i = 0; i < lum.length; i++) motion += Math.abs(lum[i] - prev[i]); motion /= lum.length; } else motion = 0;
    prev = lum;
    samples.push({ t, mean, std: Math.sqrt(vs / lum.length), sharp: lap / ((W - 2) * (Hh - 2)), motion, dark: dark / lum.length });
    if (samples.length % Math.max(1, Math.round(4 / step)) === 1 && clip.thumbs.length < 12) { tg.drawImage(v, 0, 0, tc.width, tc.height); clip.thumbs.push({ t, data: tc.toDataURL('image/jpeg', 0.6) }); }
    onStep?.(t / clip.duration);
  }
  v.removeAttribute('src'); v.load();
  // flags
  const med = a => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)] || 0; };
  const mSharp = med(samples.map(s => s.sharp)), mMotion = med(samples.map(s => s.motion));
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    s.shaky = s.motion > Math.max(0.06, mMotion * 2.4) && s.sharp < mSharp * 0.85;
    s.blurry = s.sharp < mSharp * 0.45;
    s.covered = (s.mean < 0.13 && s.std < 0.07) || s.dark > 0.7;
    s.frozen = false;
  }
  for (let i = 2; i < samples.length; i++) if (samples[i].motion < 0.0015 && samples[i - 1].motion < 0.0015) { samples[i].frozen = samples[i - 1].frozen = true; }
  for (const s of samples) s.bad = s.shaky || s.blurry || s.covered || s.frozen;
  clip.samples = samples; clip.step = step;
  clip.gain = clamp(0.46 / Math.max(0.08, med(samples.map(s => s.mean))), 0.7, 1.45); // exposure balancing between clips
  return clip;
}
async function decodeAudio(file, ctx) {
  if (file.size > 260 * 1024 * 1024) return null; // too big to decode in phone memory
  try { const buf = await file.arrayBuffer(); return await ctx.decodeAudioData(buf); } catch { return null; }
}
function rmsTrack(buf, hop = 0.25) {
  if (!buf) return []; const d = buf.getChannelData(0), sr = buf.sampleRate, n = Math.floor(hop * sr), out = [];
  for (let i = 0; i + n < d.length; i += n) { let s = 0; for (let j = 0; j < n; j += 4) s += d[i + j] ** 2; out.push(Math.sqrt(s / (n / 4))); }
  return out;
}

/* ------------------------------------------------------------------ 2. transcription (on-device Whisper) */
let asr = null;
async function transcribe(buf, onStatus) {
  if (!buf) return null;
  try {
    if (!asr) {
      onStatus?.('Downloading the speech model (first time only, ~40 MB)…');
      const T = await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.0.2');
      T.env.allowLocalModels = false;
      asr = await T.pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny.en', { device: navigator.gpu ? 'webgpu' : 'wasm' }).catch(() => T.pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny.en'));
    }
    const off = new OfflineAudioContext(1, Math.ceil(buf.duration * 16000), 16000);
    const src = off.createBufferSource(); src.buffer = buf; src.connect(off.destination); src.start();
    const mono = (await off.startRendering()).getChannelData(0);
    const r = await asr(mono, { return_timestamps: 'word', chunk_length_s: 30, stride_length_s: 5 });
    return (r.chunks || []).map(c => ({ w: c.text.trim(), s: c.timestamp[0] ?? 0, e: c.timestamp[1] ?? (c.timestamp[0] ?? 0) + 0.3 })).filter(x => x.w);
  } catch (e) { console.warn('transcription failed', e); return null; }
}

/* ------------------------------------------------------------------ 3. music: beats + loudest drop */
function beatsOf(buf) {
  const d = buf.getChannelData(0), sr = buf.sampleRate, hop = 512, env = [];
  let prevE = 0;
  for (let i = 0; i + hop < d.length; i += hop) { let e = 0; for (let j = 0; j < hop; j += 2) e += d[i + j] * d[i + j]; e = Math.sqrt(e / (hop / 2)); env.push(Math.max(0, e - prevE)); prevE = e; }
  const fps = sr / hop; let best = 0, bestLag = Math.round(fps * 0.5);
  for (let bpm = 70; bpm <= 180; bpm += 1) { const lag = fps * 60 / bpm; let s = 0; for (let i = Math.ceil(lag); i < env.length; i++) s += env[i] * env[Math.round(i - lag)]; if (s > best) { best = s; bestLag = lag; } }
  let bestPh = 0, bestS = -1; for (let ph = 0; ph < bestLag; ph++) { let s = 0; for (let i = ph; i < env.length; i += bestLag) s += env[Math.round(i)] || 0; if (s > bestS) { bestS = s; bestPh = ph; } }
  const beats = []; for (let i = bestPh; i < env.length; i += bestLag) beats.push(i / fps);
  // loudest rise (the "drop") in the first 90 s
  const sec = []; for (let s = 0; s < Math.min(buf.duration, 120); s += 1) { const a = Math.floor(s * sr), b = Math.floor((s + 1) * sr); let e = 0; for (let j = a; j < b && j < d.length; j += 64) e += d[j] * d[j]; sec.push(e); }
  let drop = 0, jump = 0; for (let i = 4; i < Math.min(sec.length, 90); i++) { const before = (sec[i - 1] + sec[i - 2] + sec[i - 3]) / 3, after = (sec[i] + (sec[i + 1] || sec[i])) / 2; if (after - before > jump) { jump = after - before; drop = i; } }
  return { beats, bpm: Math.round(60 * fps / bestLag), drop };
}

/* ------------------------------------------------------------------ 4. Claude plans the cut */
function apiKey() { try { return localStorage.getItem('sbdnj-api-key') || ''; } catch { return ''; } }
async function claude(content, maxTokens = 4000, tools) {
  const key = apiKey(); if (!key) { window.__openSettings?.('Add your Anthropic API key so the Editor can plan your cut.'); throw new Error('Add your API key in ⚙ Settings first.'); }
  const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' }, body: JSON.stringify({ model: 'claude-sonnet-5-5', max_tokens: maxTokens, messages: [{ role: 'user', content }], ...(tools ? { tools } : {}) }) });
  if (r.status === 401) { window.__openSettings?.('That API key was rejected.'); throw new Error('API key rejected.'); }
  if (!r.ok) throw new Error('Claude error ' + r.status + ' ' + (await r.text()).slice(0, 160));
  const j = await r.json(); const txt = (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  if (tools) { const src = []; for (const b of j.content || []) { if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) b.content.forEach(x => x.url && src.push({ title: x.title || x.url, url: x.url })); for (const c of b.citations || []) if (c.url) src.push({ title: c.title || c.url, url: c.url }); } return { text: txt, sources: src.filter((x, i, a) => a.findIndex(y => y.url === x.url) === i).slice(0, 8) }; }
  return txt;
}
function parseJSON(t) { t = t.trim(); try { return JSON.parse(t); } catch {} const f = t.match(/```(?:json)?\s*([\s\S]*?)```/); if (f) try { return JSON.parse(f[1]); } catch {} const a = t.indexOf('{'), b = t.lastIndexOf('}'); return JSON.parse(t.slice(a, b + 1)); }
function clipSummary(clip, i) {
  const rows = []; const per = clip.step; let k = 0;
  for (let t = 0; t < clip.duration; t += 1) {
    const ss = clip.samples.filter(s => s.t >= t && s.t < t + 1); if (!ss.length) continue;
    const flags = [...new Set(ss.flatMap(s => [s.shaky && 'shaky', s.blurry && 'blurry', s.covered && 'covered', s.frozen && 'frozen'].filter(Boolean)))].join('+');
    const words = (clip.words || []).filter(w => w.s >= t && w.s < t + 1).map(w => w.w).join(' ');
    const loud = clip.rms?.length ? Math.round(100 * Math.max(...clip.rms.slice(Math.floor(t / 0.25), Math.floor((t + 1) / 0.25)).concat([0]))) : '';
    rows.push(`${t}s ${flags || 'ok'}${loud !== '' ? ' vol' + loud : ''}${words ? ' "' + words + '"' : ''}`); k++;
  }
  return `CLIP ${i} "${clip.name}" ${clip.duration.toFixed(1)}s ${clip.w}x${clip.h}\n` + rows.join('\n');
}
async function planEdit(job) {
  const imgs = []; job.clips.forEach((c, i) => c.thumbs.forEach(th => imgs.push({ i, t: th.t, data: th.data })));
  const pick = []; const maxImg = 24; const stride = Math.max(1, imgs.length / maxImg); for (let k = 0; k < imgs.length && pick.length < maxImg; k += stride) pick.push(imgs[Math.floor(k)]);
  const content = [];
  pick.forEach((im, n) => { content.push({ type: 'text', text: `Image ${n + 1}: clip ${im.i} at ${im.t.toFixed(1)}s` }); content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: im.data.split(',')[1] } }); });
  const o = job.opts;
  content.push({ type: 'text', text:
`You are the edit team at @shotbydnj (Dag's photo/video studio): premium cinematic look, never meme-y.
Plan one edit from ONLY these clips. Per-second analysis below: flags mean shaky / blurry / covered (hands or lens covered) / frozen; vol = audio loudness; quoted text = what is said.

${job.clips.map(clipSummary).join('\n\n')}

Brief from Dag:
- Format: ${FORMATS[o.format].label}. Target length: ${o.length === 'auto' ? 'let the footage decide, cut all fluff but let good moments play' : o.length + ' seconds'}.
- Title at the start: ${o.title ? '"' + o.title + '"' : 'none'}. ${o.ending ? 'End on: ' + o.ending : ''}
- Music: ${o.music ? 'yes (cuts will snap to beats; B-roll on the beat)' : 'none, natural sound'}.
- Keep the funny and important lines with their full setup and punchline. Never cut mid-sentence. Cut every flagged moment.
- Keep clips in the order sent unless the story flows better another way.
- Dag's notes: ${o.notes || '(none)'}
- House methods the crew has researched (follow them): ${METHODS.filter(m => m.on).flatMap(m => m.rules || []).slice(0, 24).join('; ') || '(none yet)'}

Jason Roth is the Director: after planning, he signs off and writes one short director's note on story, pacing and look (what works, what Dag should watch for).
Reply with ONLY JSON:
{"title":"...","summary":"one sentence on the story of the cut","director_note":"Jason Roth's note, 1-2 sentences","segments":[{"clip":0,"in":1.5,"out":6.0,"why":"short reason","caption":"optional small caption for a key story moment or empty"}],"left_out":[{"clip":2,"why":"..."}]}
Segments play in order. in/out are seconds within that clip. Prefer segments 1.5-6 s for B-roll and full sentences for talking.` });
  const text = await claude(content, 5000);
  return parseJSON(text);
}
function cleanPlan(job, plan) {
  const segs = [];
  for (const s of plan.segments || []) {
    const clip = job.clips[s.clip | 0]; if (!clip) continue;
    let a = clamp(+s.in || 0, 0, clip.duration - 0.3), b = clamp(+s.out || a + 3, a + 0.3, clip.duration - 0.05);
    // trim flagged samples off the edges (keep speech intact: only trim where there's no word)
    const bad = t => { const smp = clip.samples.find(x => Math.abs(x.t - t) <= clip.step / 2 + 0.01); const talking = (clip.words || []).some(w => t >= w.s - 0.1 && t <= w.e + 0.1); return smp?.bad && !talking; };
    while (b - a > 0.8 && bad(a)) a += clip.step; while (b - a > 0.8 && bad(b)) b -= clip.step;
    const inside = clip.samples.filter(x => x.t >= a && x.t <= b); const badShare = inside.filter(x => x.bad).length / Math.max(1, inside.length);
    if (b - a < 0.7 || badShare > 0.6) continue;
    segs.push({ clip: s.clip | 0, in: a, out: b, why: s.why || '', caption: s.caption || '' });
  }
  // snap B-roll cut points to the beat
  if (job.music?.beats?.length && job.opts.beat) {
    let T = 0; const beats = job.music.beats.map(b => b - job.music.start).filter(b => b > 0);
    for (const s of segs) {
      const clip = job.clips[s.clip], end = T + (s.out - s.in);
      const talkingAtEnd = (clip.words || []).some(w => s.out >= w.s - 0.25 && s.out <= w.e + 0.25);
      if (!talkingAtEnd) { const nb = beats.reduce((p, c) => Math.abs(c - end) < Math.abs(p - end) ? c : p, Infinity); const d = nb - end; if (Math.abs(d) < 0.45 && s.out + d < clip.duration - 0.05 && s.out + d - s.in > 0.6) s.out += d; }
      T += s.out - s.in;
    }
  }
  // target length
  const target = job.opts.length === 'auto' ? Infinity : +job.opts.length;
  let total = segs.reduce((a, s) => a + s.out - s.in, 0);
  while (total > target * 1.12 && segs.length > 2) { const s = segs.splice(segs.length - 2, 1)[0]; total -= s.out - s.in; }
  return segs;
}

/* ------------------------------------------------------------------ 5. WebGL grade + real-time renderer */
const VS = `#version 300 es
in vec2 p; out vec2 uv; void main(){ uv = p*0.5+0.5; gl_Position = vec4(p,0.,1.); }`;
const FS = `#version 300 es
precision highp float; precision highp sampler3D;
uniform sampler3D L; uniform float lutMix, lutN;
uniform sampler2D A, B; uniform float mixAB, gainA, gainB, contrast, sat, warm, lift, roll, grain, time, bars, fade;
uniform vec2 scA, ofA, scB, ofB; uniform vec3 sh, hi; in vec2 uv; out vec4 o;
vec3 grade(vec3 c){ c = clamp(c,0.,1.); c *= vec3(1.+warm,1.,1.-warm); c = c + contrast*(c-0.5)*(1.-abs(2.*c-1.))*2.; c = clamp(c,0.,1.);
  c = 1.-pow(1.-c, vec3(1.+roll)); c = lift + c*(1.-lift); float l = dot(c,vec3(.3333)); c += sh*(1.-l)+hi*l;
  float g = dot(c,vec3(.3333)); float s = max(c.r,max(c.g,c.b))-min(c.r,min(c.g,c.b)); float k = sat>1. ? 1.+(sat-1.)*(1.-s) : sat; return clamp(g+(c-g)*k,0.,1.); }
vec3 tap(sampler2D t, vec2 sc, vec2 of, float gn){ vec2 q = uv*sc+of; return texture(t, vec2(q.x, 1.-q.y)).rgb*gn; }
void main(){ vec3 c = grade(mix(tap(A,scA,ofA,gainA), tap(B,scB,ofB,gainB), mixAB));
  if (lutMix > 0.) { vec3 q = clamp(c,0.,1.)*(lutN-1.)/lutN + 0.5/lutN; c = mix(c, texture(L, q).rgb, lutMix); }
  float n = fract(sin(dot(uv*vec2(1234.5,987.6)+time, vec2(12.9898,78.233)))*43758.5453); c += (n-.5)*grain; c *= 1.-fade;
  if (uv.y < bars || uv.y > 1.-bars) c = vec3(0.); o = vec4(c,1.); }`;
function makeGL(canvas) {
  const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true, premultipliedAlpha: false }); if (!gl) throw new Error('This device has no WebGL2.');
  const sh = (t, s) => { const x = gl.createShader(t); gl.shaderSource(x, s); gl.compileShader(x); if (!gl.getShaderParameter(x, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(x)); return x; };
  const pr = gl.createProgram(); gl.attachShader(pr, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(pr); gl.useProgram(pr);
  const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(pr, 'p'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const tex = [0, 1].map(i => { const t = gl.createTexture(); gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_2D, t); for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255])); return t; });
  gl.uniform1i(gl.getUniformLocation(pr, 'A'), 0); gl.uniform1i(gl.getUniformLocation(pr, 'B'), 1);
  const lutTex = gl.createTexture(); gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_3D, lutTex); for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_3D, k, v);
  gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, 2, 2, 2, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0,0,0,255, 255,0,0,255, 0,255,0,255, 255,255,0,255, 0,0,255,255, 255,0,255,255, 0,255,255,255, 255,255,255,255])); let lutN = 2;
  gl.uniform1i(gl.getUniformLocation(pr, 'L'), 2);
  const U = n => gl.getUniformLocation(pr, n);
  return {
    gl, setLUT(lut) { gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_3D, lutTex); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1); gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, lut.N, lut.N, lut.N, 0, gl.RGBA, gl.UNSIGNED_BYTE, lut.data); lutN = lut.N; },
    upload(i, src) { gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_2D, tex[i]); try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src); } catch {} },
    draw(u) { gl.viewport(0, 0, canvas.width, canvas.height); const L = u.look;
      gl.uniform1f(U('mixAB'), u.mix); gl.uniform1f(U('gainA'), u.gainA); gl.uniform1f(U('gainB'), u.gainB);
      gl.uniform2f(U('scA'), ...u.scA); gl.uniform2f(U('ofA'), ...u.ofA); gl.uniform2f(U('scB'), ...u.scB); gl.uniform2f(U('ofB'), ...u.ofB);
      gl.uniform1f(U('contrast'), L.contrast); gl.uniform1f(U('sat'), L.sat); gl.uniform1f(U('warm'), L.warm); gl.uniform1f(U('lift'), L.lift); gl.uniform1f(U('roll'), L.roll);
      gl.uniform3f(U('sh'), ...L.sh); gl.uniform3f(U('hi'), ...L.hi); gl.uniform1f(U('grain'), u.grain ?? L.grain); gl.uniform1f(U('time'), u.time % 100); gl.uniform1f(U('bars'), u.bars); gl.uniform1f(U('fade'), u.fade);
      gl.uniform1f(U('lutMix'), u.lutMix || 0); gl.uniform1f(U('lutN'), lutN);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); },
  };
}
function cover(sw, shh, ow, oh) { const sa = sw / shh, oa = ow / oh; if (!sw || !shh) return [[1, 1], [0, 0]]; if (sa > oa) { const sx = oa / sa; return [[sx, 1], [(1 - sx) / 2, 0]]; } const sy = sa / oa; return [[1, sy], [0, (1 - sy) / 2]]; }

async function renderEdit(job, { record, quality, onProgress, canvasOut, signal }) {
  const F = FORMATS[job.opts.format]; const scale = quality === 'final' ? 1 : 0.5;
  const W = Math.round(F.w * scale / 2) * 2, Hh = Math.round(F.h * scale / 2) * 2;
  const glc = document.createElement('canvas'); glc.width = W; glc.height = Hh; const R = makeGL(glc);
  const out = canvasOut || document.createElement('canvas'); out.width = W; out.height = Hh; const g = out.getContext('2d');
  const RL = await resolveLook(job.opts.look); const look = RL.look; if (RL.lut) R.setLUT(RL.lut);
  const ctx = new (window.AudioContext || window.webkitAudioContext)(); await ctx.resume();
  const bus = ctx.createGain(); bus.gain.value = 0.8; const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -10; comp.ratio.value = 3; bus.connect(comp);
  const dest = ctx.createMediaStreamDestination(); comp.connect(dest); if (!record) comp.connect(ctx.destination);
  // one player per clip, unlocked inside the user's tap
  const players = job.clips.map(c => { const v = videoEl(c.url); v.muted = false; v.volume = 1; const node = ctx.createMediaElementSource(v); const gn = ctx.createGain(); gn.gain.value = 0; node.connect(gn).connect(bus); return { v, gn }; });
  await Promise.all(players.map(async p => { await loadMeta(p.v); try { await p.v.play(); p.v.pause(); } catch {} }));
  const segs = job.segments; const xf = job.opts.transition === 'dissolve' ? 0.45 : 0;
  const starts = []; let T = 0; segs.forEach((s, i) => { starts.push(T); T += (s.out - s.in) - (i < segs.length - 1 ? xf : 0); });
  const total = T + 0.05;
  // music + ducking under speech
  let music = null;
  if (job.music?.buffer) {
    music = ctx.createBufferSource(); music.buffer = job.music.buffer; const mg = ctx.createGain(); music.connect(mg).connect(bus);
    const base = 0.55, duck = 0.16, t0 = ctx.currentTime + 0.25; mg.gain.setValueAtTime(0, t0);
    mg.gain.linearRampToValueAtTime(base, t0 + 1.0);
    segs.forEach((s, i) => { const clip = job.clips[s.clip]; for (const w of clip.words || []) if (w.s >= s.in && w.e <= s.out) { const at = t0 + starts[i] + (w.s - s.in); mg.gain.setTargetAtTime(duck, Math.max(t0 + 1, at - 0.25), 0.08); mg.gain.setTargetAtTime(base, at + (w.e - w.s) + 0.35, 0.3); } });
    mg.gain.setValueAtTime(base, t0 + total - 2.2); mg.gain.linearRampToValueAtTime(0, t0 + total);
    music.start(t0, job.music.start || 0);
    var tStart = t0;
  } else var tStart = ctx.currentTime + 0.25;
  // mutes (words to bleep out), mapped to output time per segment
  const muteAt = (i, clipT) => { const c = job.clips[segs[i].clip]; return (c.mutes || []).some(m => clipT >= m.s - 0.05 && clipT <= m.e + 0.05); };
  // recorder
  let rec = null, chunks = [], mime = '';
  if (record) {
    const vs = out.captureStream(30); const stream = new MediaStream([...vs.getVideoTracks(), ...dest.stream.getAudioTracks()]);
    mime = ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm'].find(m => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
    rec = new MediaRecorder(stream, { mimeType: mime || undefined, videoBitsPerSecond: quality === 'final' ? 12e6 : 4e6, audioBitsPerSecond: 192000 }); rec.ondataavailable = e => e.data.size && chunks.push(e.data); rec.start(1000);
  }
  let wake = null; try { wake = await navigator.wakeLock?.request('screen'); } catch {}
  // prepare first segment
  await seek(players[segs[0].clip].v, segs[0].in);
  let cur = -1; const titleFont = '"Playfair Display", Georgia, serif';
  const done = new Promise(resolve => {
    const frame = () => {
      if (signal?.aborted) return resolve('stopped');
      const now = ctx.currentTime - tStart;
      if (now < 0) { requestAnimationFrame(frame); return; }
      if (now >= total) return resolve('done');
      let i = 0; while (i + 1 < segs.length && now >= starts[i + 1]) i++;
      if (i !== cur) { // cut / start next
        const s = segs[i], p = players[s.clip]; const local = s.in + (now - starts[i]);
        if (Math.abs(p.v.currentTime - local) > 0.2) p.v.currentTime = local;
        p.v.play().catch(() => {}); p.gn.gain.setTargetAtTime(1, ctx.currentTime, 0.03);
        if (cur >= 0 && segs[cur].clip !== s.clip) { const prev = players[segs[cur].clip]; prev.gn.gain.setTargetAtTime(0, ctx.currentTime + 0.25, 0.12); setTimeout(() => { if (segs[cur]?.clip !== segs.indexOf && players[segs[cur].clip] !== prev) prev.v.pause(); }, 900 + xf * 1000); } // L-cut: the last shot's sound tails under the new picture
        cur = i;
        // preload the next segment's clip
        const n = segs[i + 1]; if (n && n.clip !== s.clip) { const np = players[n.clip]; np.v.currentTime = n.in; }
        onProgress?.(now / total, i);
      }
      const s = segs[i], p = players[s.clip], c = job.clips[s.clip];
      const local = s.in + (now - starts[i]); if (Math.abs(p.v.currentTime - local) > 0.35) p.v.currentTime = local; // drift guard
      const m = muteAt(i, p.v.currentTime); if (m !== !!p.muted) { p.muted = m; p.gn.gain.setTargetAtTime(m ? 0 : 1, ctx.currentTime, 0.01); }
      R.upload(0, p.v); const [scA, ofA] = cover(c.w, c.h, W, Hh);
      let mix = 0, scB = scA, ofB = ofA, gainB = c.gain;
      // dissolve: the first xf seconds of a shot blend in from the previous shot
      const prevSeg = segs[i - 1];
      if (xf && prevSeg && prevSeg.clip !== s.clip && now - starts[i] < xf) { const pp = players[prevSeg.clip], pc = job.clips[prevSeg.clip]; R.upload(1, pp.v); [scB, ofB] = cover(pc.w, pc.h, W, Hh); gainB = pc.gain; mix = 1 - clamp((now - starts[i]) / xf, 0, 1); }
      const fade = Math.max(now < 0.6 ? 1 - now / 0.6 : 0, now > total - 1.2 ? (now - (total - 1.2)) / 1.2 : 0);
      R.draw({ look, mix, gainA: c.gain * RL.expo, gainB: gainB * RL.expo, lutMix: RL.lut ? 1 : 0, scA, ofA, scB, ofB, bars: FORMATS[job.opts.format].bars, fade, time: now });
      g.drawImage(glc, 0, 0);
      // title: clean serif, fades in and out over the first ~4 s
      if (job.title && now < 4.6) { const a = Math.min(clamp((now - 0.5) / 0.8, 0, 1), clamp((4.4 - now) / 0.8, 0, 1)); g.save(); g.globalAlpha = a; g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.shadowColor = 'rgba(0,0,0,.6)'; g.shadowBlur = W * 0.02; g.font = `600 ${Math.round(Math.min(W, Hh) * 0.105)}px ${titleFont}`; g.fillText(job.title, W / 2, Hh / 2); g.restore(); }
      // small captions on key story moments
      if (s.caption && now - starts[i] < Math.min(3.2, s.out - s.in)) { g.save(); g.font = `500 ${Math.round(Math.min(W, Hh) * 0.034)}px ${titleFont}`; g.textAlign = 'center'; g.fillStyle = 'rgba(255,255,255,.92)'; g.shadowColor = 'rgba(0,0,0,.7)'; g.shadowBlur = 8; const y = FORMATS[job.opts.format].bars ? Hh * (1 - FORMATS[job.opts.format].bars) - Hh * 0.04 : Hh * 0.86; g.fillText(s.caption, W / 2, y); g.restore(); }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
  const result = await done;
  try { music?.stop(); } catch {}
  players.forEach(p => { try { p.v.pause(); p.v.removeAttribute('src'); p.v.load(); } catch {} });
  try { wake?.release(); } catch {}
  let blob = null;
  if (rec) { await new Promise(r => { rec.onstop = r; rec.stop(); }); blob = new Blob(chunks, { type: (mime || 'video/webm').split(';')[0] }); }
  ctx.close();
  return { result, blob, duration: total, ext: (mime || 'video/webm').includes('mp4') ? 'mp4' : 'webm' };
}

/* ------------------------------------------------------------------ photos: grade + 4:5 crop */
async function gradePhoto(file, lookKey) {
  const RL = await resolveLook(lookKey);
  const url = URL.createObjectURL(file); const img = new Image(); img.src = url; await img.decode();
  const maxSide = 4096, k = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const W = Math.round(img.naturalWidth * k), Hh = Math.round(img.naturalHeight * k);
  const c = document.createElement('canvas'); c.width = W; c.height = Hh; const R = makeGL(c); R.upload(0, img); if (RL.lut) R.setLUT(RL.lut);
  // exposure balance from a tiny thumbnail
  const t = document.createElement('canvas'); t.width = 64; t.height = 64; const tg = t.getContext('2d'); tg.drawImage(img, 0, 0, 64, 64); const d = tg.getImageData(0, 0, 64, 64).data; let m = 0; for (let i = 0; i < d.length; i += 4) m += (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) / 255; m /= 4096;
  R.draw({ look: RL.look, lutMix: RL.lut ? 1 : 0, mix: 0, gainA: clamp(0.47 / Math.max(0.08, m), 0.8, 1.3) * RL.expo, gainB: 1, scA: [1, 1], ofA: [0, 0], scB: [1, 1], ofB: [0, 0], bars: 0, fade: 0, time: 1, grain: (RL.look.grain || 0.02) * 0.6 });
  // 4:5 feed crop (center)
  const fw = Math.min(W, Math.round(Hh * 0.8)), fh = Math.round(fw * 1.25) > Hh ? Hh : Math.round(fw * 1.25);
  const crop = document.createElement('canvas'); crop.width = Math.min(1080, fw); crop.height = Math.round(crop.width * 1.25); crop.getContext('2d').drawImage(c, (W - fw) / 2, (Hh - fh) / 2, fw, fh, 0, 0, crop.width, crop.height);
  const master = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.94)); const feed = await new Promise(r => crop.toBlob(r, 'image/jpeg', 0.92));
  URL.revokeObjectURL(url);
  return { master, feed };
}

/* ------------------------------------------------------------------ sharing */
async function shareOrSave(blob, name, text) {
  const file = new File([blob], name, { type: blob.type });
  if (navigator.canShare?.({ files: [file] })) { try { await navigator.share({ files: [file], text }); return 'shared'; } catch (e) { if (e?.name === 'AbortError') return 'cancelled'; } }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 60000); return 'downloaded';
}

/* ------------------------------------------------------------------ UI: Edit tab + edit bay */
const state = { job: null, stage: 'idle', progress: 0, msg: '', finished: [], ctl: null };
const STAGES = [['ingest', 'Ingestion Agent', 'Loading your clips'], ['analyze', 'Assistant Editor', 'Scanning for shaky, blurry, covered and frozen moments'], ['transcribe', 'Story Editor', 'Transcribing what you say'], ['music', 'Sound Designer', 'Finding the beat and planning music ducking'], ['plan', 'The Editor + Jason Roth', 'Planning the cut with Claude; the Director signs off'], ['review', 'Dag', 'Your call: approve the plan or correct it'], ['render', 'Render Agent', 'Rendering your edit'], ['qa', 'QA Reviewer', 'Checking the export'], ['done', 'Producer', 'Delivered to the Finished wall']];
const crewFor = { ingest: 'ingest', analyze: 'asst', transcribe: 'story', music: 'sound', plan: 'editor', render: 'render', qa: 'qa', done: 'producer' };
function setStage(stage, msg, prog = 0) {
  state.stage = stage; state.msg = msg || ''; state.progress = prog;
  const row = STAGES.find(s => s[0] === stage); if (row && crewFor[stage]) { crew(crewFor[stage], row[2] + (prog ? ` · ${Math.round(prog * 100)}%` : '')); if (stage === 'render') crew('colorist', `Grading every shot to the ${state.job?.opts.look} look`); }
  paint();
}
function paint() { const p = $('#pane'); if (p && H()?.currentTab?.() === 'edit') editPane(p); else updateBadge(); }
function updateBadge() { const b = $('[data-tab="edit"]'); if (b) b.textContent = state.stage !== 'idle' && state.stage !== 'done' ? 'Edit ●' : 'Edit'; }

async function refreshFinished() { state.finished = await listFinished(); }
export async function editPane(pane) {
  updateBadge();
  const j = state.job; const busy = !['idle', 'done', 'review', 'error'].includes(state.stage);
  const stageList = STAGES.map(([k, who, what]) => { const idx = STAGES.findIndex(s => s[0] === state.stage), my = STAGES.findIndex(s => s[0] === k); const st = idx > my || state.stage === 'done' ? '✓' : idx === my ? '●' : '○'; return `<div class="note" style="display:flex;gap:8px"><b style="width:14px;color:${st === '●' ? 'var(--accent)' : 'inherit'}">${st}</b><span><b>${esc(who)}</b> · ${esc(what)}${idx === my && state.progress ? ` · ${Math.round(state.progress * 100)}%` : ''}</span></div>`; }).join('');
  const planHtml = j?.segments ? `<div class="card"><div class="top"><span class="who">The cut · ${j.segments.length} shots · ${fmt(j.segments.reduce((a, s) => a + s.out - s.in, 0))}</span></div>
      <span class="note">${esc(j.plan?.summary || '')}</span>
      ${j.plan?.director_note ? `<span class="note"><b>Jason Roth, Director:</b> ${esc(j.plan.director_note)}</span>` : ''}
      ${j.segments.map((s, i) => { const c = j.clips[s.clip]; const th = c.thumbs.reduce((p, x) => Math.abs(x.t - s.in) < Math.abs(p.t - s.in) ? x : p, c.thumbs[0] || { data: '' }); return `<div style="display:grid;grid-template-columns:64px 1fr;gap:8px;align-items:center"><img src="${th.data}" alt="" style="width:64px;border-radius:6px"><span class="note"><b>${i + 1}. ${esc(c.name.slice(0, 22))}</b> ${fmt(s.in)}–${fmt(s.out)}<br>${esc(s.why)}${s.caption ? ` · caption: “${esc(s.caption)}”` : ''}</span></div>`; }).join('')}
      ${(j.plan?.left_out || []).length ? `<span class="eyebrow">Left out</span>${j.plan.left_out.map(l => `<span class="note">${esc(j.clips[l.clip]?.name || 'clip ' + l.clip)}: ${esc(l.why)}</span>`).join('')}` : ''}
    </div>` : '';
  const fin = state.finished.map(f => `<div class="card" data-fid="${f.id}">${f.kind === 'video' ? `<video src="${URL.createObjectURL(f.blob)}" controls playsinline preload="metadata" style="width:100%;border-radius:8px;background:#000"></video>` : `<img src="${URL.createObjectURL(f.blob)}" alt="" style="width:100%;border-radius:8px">`}
      <span class="who">${esc(f.title)}</span><span class="note">${new Date(f.at).toLocaleString()}${f.duration ? ' · ' + fmt(f.duration) : ''}</span>
      <div class="row"><button class="primary" data-share>Save / Share</button>${f.kind === 'video' ? '<button data-wall>Show on big screen</button>' : ''}<button data-ig>Open Instagram</button><button data-del>Delete</button></div><div data-conf></div></div>`).join('');
  pane.innerHTML = `<span class="eyebrow">Edit bay · real editing on this device</span><h2>Make an edit</h2>
    <p class="note">The crew really edits here: your clips are scanned, transcribed and planned with Claude, graded to the house look, and rendered into a video you can save or post. Nothing is uploaded except a few small frames and the transcript sent to Claude for the plan.</p>
    ${busy || state.stage === 'review' ? '' : `
    <label class="note" for="eClips">Clips and/or photos (in order)</label><input id="eClips" type="file" multiple accept="video/*,image/*">
    <label class="note" for="eMusic">Song (optional, mp3/m4a)</label><input id="eMusic" type="file" accept="audio/*">
    <div class="row"><select id="eFormat" aria-label="Format"><option value="reel">Reel 9:16</option><option value="film">Film 16:9 + 2.39 bars</option><option value="square">Feed 4:5</option></select>
      <select id="eLook" aria-label="Look">${lookOptions().map(([v, l]) => `<option value="${esc(v)}"${v === defaultLook() ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>
      <select id="eLen" aria-label="Length"><option value="auto">Length: auto</option><option value="15">15 s</option><option value="30">30 s</option><option value="60">60 s</option><option value="90">90 s</option><option value="180">3 min</option></select>
      <select id="eTrans" aria-label="Transitions"><option value="cut">Clean cuts</option><option value="dissolve">Soft dissolves</option></select></div>
    <input id="eTitle" maxlength="60" placeholder="Title at the start (optional)">
    <input id="eEnd" maxlength="140" placeholder="End on… (a clip or a line, optional)">
    <textarea id="eNotes" placeholder="Notes for the crew, e.g. keep the car jokes with the full setup, mountain reveal near the end, cut fast on the beat"></textarea>
    <div class="row"><label class="note"><input type="checkbox" id="eTx" checked style="width:auto"> Transcribe talking</label><label class="note"><input type="checkbox" id="eMute" checked style="width:auto"> Mute the n-word</label><label class="note"><input type="checkbox" id="eBeat" checked style="width:auto"> Cut on the beat</label></div>
    <button class="primary" id="eGo">Start edit</button>
    <p class="note">Photos only? They're graded and cropped 4:5 right away. Tip: keep the app open and the screen on while it renders; rendering runs in real time (a 60 s edit takes about 60 s).</p>`}
    ${state.stage !== 'idle' ? `<div class="card"><span class="who">${state.stage === 'error' ? 'Something went wrong' : state.stage === 'done' ? 'Done' : 'Working'}</span>${stageList}<span class="note" style="color:${state.stage === 'error' ? '#E07A6A' : 'inherit'}">${esc(state.msg)}</span>${busy ? '<button id="eStop">Stop</button>' : ''}</div>` : ''}
    ${planHtml}
    ${state.stage === 'review' ? `<textarea id="eFix" placeholder="Want changes? e.g. drop shot 3, hold the reveal longer, end on the summit line"></textarea>
      <div class="row"><button class="primary" id="eApprove">Approve and render</button><button id="ePreview">Watch draft</button><button id="eReplan">Re-plan with my notes</button><button id="eCancel">Cancel</button></div>` : ''}
    ${state.stage === 'done' ? '<button id="eNew">New edit</button>' : ''}
    <span class="eyebrow" style="margin-top:8px">Finished work · saved on this device</span>
    ${fin || '<p class="note">Finished edits show here and play on the big screens.</p>'}
    <div class="row"><a class="note" href="https://instagram.com/shotbydnj" target="_blank" rel="noopener">@shotbydnj on Instagram ↗</a></div>`;
  $('#eGo', pane)?.addEventListener('click', startJob);
  $('#eStop', pane)?.addEventListener('click', () => { state.ctl?.abort(); state.stage = 'error'; state.msg = 'Stopped.'; crewDone(Object.values(crewFor).concat('colorist')); paint(); });
  $('#eNew', pane)?.addEventListener('click', () => { state.job = null; state.stage = 'idle'; paint(); });
  $('#eCancel', pane)?.addEventListener('click', () => { state.job = null; state.stage = 'idle'; crewDone(Object.values(crewFor)); paint(); });
  $('#eApprove', pane)?.addEventListener('click', () => renderJob('final'));
  $('#ePreview', pane)?.addEventListener('click', () => renderJob('draft'));
  $('#eReplan', pane)?.addEventListener('click', async () => { const fix = $('#eFix', pane).value.trim(); if (!fix) return; state.job.opts.notes = (state.job.opts.notes ? state.job.opts.notes + '\n' : '') + 'Correction from Dag: ' + fix; say(`<b>Dag</b> sent a correction: “${esc(fix.slice(0, 80))}”`); await plan(); });
  pane.querySelectorAll('[data-fid]').forEach(card => { const f = state.finished.find(x => x.id === card.dataset.fid); if (!f) return;
    $('[data-share]', card).onclick = async () => { const r = await shareOrSave(f.blob, f.file, f.caption || ''); if (r === 'downloaded') card.querySelector('.note').textContent += ' · downloaded'; };
    $('[data-wall]', card)?.addEventListener('click', () => { H()?.showFinished?.(URL.createObjectURL(f.blob), f.title); });
    $('[data-ig]', card).onclick = () => { window.open('https://instagram.com/shotbydnj', '_blank'); };
    $('[data-del]', card).onclick = () => { const c = $('[data-conf]', card); c.innerHTML = '<div class="row"><button data-y>Delete for good</button><button data-n>Keep</button></div>'; $('[data-n]', c).onclick = () => c.innerHTML = ''; $('[data-y]', c).onclick = async () => { await deleteFinished(f.id); await refreshFinished(); paint(); }; };
  });
}

async function startJob() {
  const files = [...($('#eClips')?.files || [])]; if (!files.length) { alertNote('Pick your clips first.'); return; }
  const opts = { format: $('#eFormat').value, look: $('#eLook').value, length: $('#eLen').value, transition: $('#eTrans').value, title: $('#eTitle').value.trim(), ending: $('#eEnd').value.trim(), notes: $('#eNotes').value.trim(), tx: $('#eTx').checked, mute: $('#eMute').checked, beat: $('#eBeat').checked };
  const musicFile = $('#eMusic')?.files?.[0] || null; opts.music = !!musicFile;
  const vids = files.filter(f => f.type.startsWith('video/') || /\.(mov|mp4|m4v|webm)$/i.test(f.name)), photos = files.filter(f => f.type.startsWith('image/'));
  state.ctl = new AbortController(); state.job = { opts, clips: [], photos };
  try {
    if (photos.length) {
      setStage('analyze', `Grading ${photos.length} photo(s) to the ${opts.look} look`); crew('photoeditor', `Grading ${photos.length} photos to the ${opts.look} look`); crew('retoucher', 'Checking each photo');
      for (const [i, f] of photos.entries()) { const { feed } = await gradePhoto(f, opts.look); const name = f.name.replace(/\.[^.]+$/, '') + `_${lookFileTag(opts.look)}_4x5.jpg`; await saveFinished({ id: 'p' + Date.now() + i, kind: 'photo', blob: feed, file: name, title: `${f.name} · ${(lookOptions().find(o => o[0] === opts.look) || [0, opts.look])[1]}`, at: Date.now() }); state.progress = (i + 1) / photos.length; paint(); }
      crewDone(['photoeditor', 'retoucher']); say(`<b>Photo Editor</b> graded ${photos.length} photo(s) to the ${opts.look} look`);
      await refreshFinished();
      if (!vids.length) { setStage('done', `${photos.length} photo(s) graded. Tap Save / Share to put them in your camera roll or post them.`); return; }
    }
    setStage('ingest', `Loading ${vids.length} clip(s)`);
    state.job.clips = vids.map(f => ({ file: f, name: f.name, url: URL.createObjectURL(f) }));
    const actx = new (window.AudioContext || window.webkitAudioContext)();
    for (const [i, c] of state.job.clips.entries()) {
      if (state.ctl.signal.aborted) return;
      setStage('analyze', `Clip ${i + 1} of ${vids.length}: ${c.name}`, i / vids.length);
      await analyzeClip(c, p => { state.progress = (i + p) / vids.length; if (Math.random() < 0.15) paint(); });
      c.audio = await decodeAudio(c.file, actx); c.rms = rmsTrack(c.audio);
    }
    const flagged = state.job.clips.reduce((a, c) => a + c.samples.filter(s => s.bad).length * c.step, 0);
    say(`<b>Assistant Editor</b> scanned ${vids.length} clip(s) and flagged ${Math.round(flagged)} s of shaky, blurry, covered or frozen footage`);
    if (opts.tx) {
      for (const [i, c] of state.job.clips.entries()) {
        if (state.ctl.signal.aborted) return;
        setStage('transcribe', c.audio ? `Clip ${i + 1}: listening…` : `Clip ${i + 1}: audio too large to transcribe on this device, skipping`, i / vids.length);
        c.words = c.audio ? (await transcribe(c.audio, m => { state.msg = m; paint(); })) || [] : [];
        c.mutes = opts.mute ? c.words.filter(w => MUTE_DEFAULT.test(w.w)).map(w => ({ s: w.s, e: w.e })) : [];
      }
      const nw = state.job.clips.reduce((a, c) => a + (c.words?.length || 0), 0), nm = state.job.clips.reduce((a, c) => a + (c.mutes?.length || 0), 0);
      say(`<b>Story Editor</b> transcribed ${nw} words${nm ? `, ${nm} to mute` : ''}`);
    }
    if (musicFile) {
      setStage('music', 'Reading the song');
      const buf = await decodeAudio(musicFile, actx);
      if (buf) { const b = beatsOf(buf); state.job.music = { buffer: buf, beats: b.beats, start: Math.max(0, b.drop - 0.5), bpm: b.bpm }; say(`<b>Sound Designer</b> found ${b.bpm} BPM; the drop hits at ${fmt(b.drop)}`); }
    }
    actx.close();
    await plan();
  } catch (e) { console.error(e); state.stage = 'error'; state.msg = String(e?.message || e); crewDone(Object.values(crewFor)); paint(); }
}
async function plan() {
  const j = state.job;
  try {
    setStage('plan', 'The Editor and Story Editor are looking at your frames and transcript…');
    crew('scout', 'Comparing your frames to references'); crew('story', 'Choosing which lines stay'); crew('jason', 'Reviewing the Editor\'s plan');
    const p = await planEdit(j); j.plan = p; j.title = j.opts.title || p.title || ''; j.segments = cleanPlan(j, p);
    if (!j.segments.length) throw new Error('No usable segments came back. Try different clips or notes.');
    crewDone(['scout', 'story', 'editor', 'jason']); if (p.director_note) say(`<b>Jason Roth</b> signed off: “${esc(p.director_note.slice(0, 120))}”`);
    say(`<b>The Editor</b> planned a ${fmt(j.segments.reduce((a, s) => a + s.out - s.in, 0))} cut in ${j.segments.length} shots`);
    setStage('review', 'Review the plan. Watch a draft, approve it, or send a correction.');
    crew('dag', 'Reviewing the plan', 600000);
  } catch (e) { state.stage = 'error'; state.msg = String(e?.message || e); crewDone(Object.values(crewFor)); paint(); }
}
async function renderJob(quality) {
  const j = state.job; crewDone(['dag']);
  const bay = openBay(quality === 'final' ? 'Rendering final' : 'Draft preview');
  state.ctl = new AbortController(); bay.stop.onclick = () => state.ctl.abort();
  try {
    setStage('render', quality === 'final' ? 'Rendering the final. Keep the app open.' : 'Playing the draft (not saved)');
    const r = await renderEdit(j, { record: quality === 'final', quality, canvasOut: bay.canvas, signal: state.ctl.signal, onProgress: (p) => { state.progress = p; bay.bar.style.width = (p * 100).toFixed(1) + '%'; if (Math.random() < 0.2) paint(); } });
    closeBay();
    if (r.result === 'stopped') { setStage('review', 'Stopped. Approve again when ready.'); return; }
    if (quality !== 'final') { setStage('review', 'That was the draft. Approve to render the final, or send a correction.'); return; }
    setStage('qa', 'Checking the file');
    if (!r.blob || r.blob.size < 50000) throw new Error('The export came out empty. Try again with the app in the foreground.');
    const name = (j.title || 'shotbydnj_edit').replace(/[^\w\- ]+/g, '').replace(/\s+/g, '_').slice(0, 40) + `_${j.opts.format}.${r.ext}`;
    const caption = `${j.title ? j.title + ' · ' : ''}shot + edited by @shotbydnj`;
    const id = 'v' + Date.now(); await saveFinished({ id, kind: 'video', blob: r.blob, file: name, title: j.title || 'Untitled edit', caption, duration: r.duration, at: Date.now() });
    await refreshFinished();
    H()?.showFinished?.(URL.createObjectURL(r.blob), j.title || 'New edit');
    crewDone(Object.values(crewFor).concat('colorist'));
    say(`<b>Producer</b> delivered “${esc(j.title || 'your edit')}” (${fmt(r.duration)}) to the Finished wall`);
    setStage('done', `Finished: ${fmt(r.duration)} ${r.ext.toUpperCase()}, ${(r.blob.size / 1e6).toFixed(1)} MB. Tap Save / Share to put it in Photos or post it.`);
  } catch (e) { closeBay(); console.error(e); state.stage = 'error'; state.msg = String(e?.message || e); crewDone(Object.values(crewFor).concat('colorist')); paint(); }
}
function alertNote(t) { const p = $('#pane'); if (p) { const n = document.createElement('p'); n.className = 'note'; n.style.color = '#E07A6A'; n.textContent = t; p.prepend(n); } }
function openBay(label) {
  let b = $('#editBay');
  if (!b) { b = document.createElement('div'); b.id = 'editBay'; b.innerHTML = `<div class="bayIn"><div class="row" style="justify-content:space-between;align-items:center"><b id="bayLabel"></b><button id="bayStop">Stop</button></div><canvas id="bayCanvas"></canvas><div style="height:4px;background:rgba(255,255,255,.12);border-radius:2px"><div id="bayBar" style="height:4px;width:0;background:#E8A33D;border-radius:2px"></div></div><span class="note">Keep the app open and the screen on.</span></div>`; document.body.appendChild(b); }
  b.hidden = false; $('#bayLabel', b).textContent = label; $('#bayBar', b).style.width = '0';
  return { canvas: $('#bayCanvas', b), stop: $('#bayStop', b), bar: $('#bayBar', b) };
}
function closeBay() { const b = $('#editBay'); if (b) b.hidden = true; }

/* ------------------------------------------------------------------ Presets & Methods tab */
const pstate = { busy: '', err: '', researching: '' };
async function storageLine() { try { const e = await navigator.storage?.estimate?.(); const p = await navigator.storage?.persisted?.(); if (!e) return ''; const gb = x => (x / 1e9).toFixed(x > 1e9 ? 1 : 2) + ' GB'; return `Using ${gb(e.usage || 0)} of ${gb(e.quota || 0)} on this device${p ? ' · protected from auto-clean' : ''}`; } catch { return ''; } }
function mb(n) { return n > 1e9 ? (n / 1e9).toFixed(2) + ' GB' : (n / 1e6).toFixed(1) + ' MB'; }
async function importPresets(files) {
  try { await navigator.storage?.persist?.(); } catch {}
  crew('lookdev', `Loading ${files.length} preset file${files.length > 1 ? 's' : ''} into the library`, 60000);
  for (const f of files) {
    pstate.busy = `Saving ${f.name} (${mb(f.size)})…`; paintP();
    const kind = kindOf(f.name); const item = { id: 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: f.name.replace(/\.[^.]+$/, ''), file: f.name, kind, size: f.size, type: f.type, at: Date.now(), by: (localStorage.getItem('sbdnj-name') || '').trim() || 'Dag', blob: f };
    try { if (kind === 'lut') { const L = parseCube(await f.text()); item.info = `${L.N}×${L.N}×${L.N} cube · applied for real in the grade`; }
      if (kind === 'xmp') { const x = parseXMP(await f.text()); item.info = `Converted: contrast ${x.contrast.toFixed(2)}, saturation ${x.sat.toFixed(2)}, warmth ${x.warm.toFixed(3)}, exposure ×${x.expo.toFixed(2)}`; }
      await putIn('presets', item);
    } catch (e) { pstate.err = `${f.name}: ${e.message || e}`; if (e?.name === 'QuotaExceededError') pstate.err = `${f.name}: this device is out of room for the app. Free up space or keep that file in Drive.`; }
  }
  pstate.busy = ''; crewDone(['lookdev']); await loadLibrary(); paintP();
}
async function researchMethod(topic) {
  pstate.researching = topic; pstate.err = ''; paintP(); crew('jason', `Researching: ${topic}`, 300000); crew('lookdev', 'Pulling references for a new method', 300000);
  const prompt = `You are Jason Roth, director at @shotbydnj, a premium cinematic photo/video studio (moody, warm, clean house looks; never meme-y). Research this editing / photography / color technique and turn it into something the studio's auto-editor can follow:

"${topic}"

Use current, credible sources (pro colorists, editors, cinematographers). Return ONLY JSON:
{"title": short name, "summary": 2 sentences, "steps": [concrete steps a human editor would do, max 8], "edit_rules": [short rules the auto-editor follows when choosing and timing shots, max 6, e.g. "hold wide establishing shots 2-3s before cutting in"], "look": null OR {"contrast": -0.2..0.35, "sat": 0.2..1.6, "warm": -0.08..0.08, "lift": -0.06..0.1, "roll": -0.1..0.3, "sh": [r,g,b each -0.03..0.03 shadow tint], "hi": [r,g,b highlight tint], "grain": 0..0.08} only if the technique is a color look}`;
  try {
    let out, web = true;
    try { out = await claude([{ type: 'text', text: prompt }], 3000, [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }]); }
    catch (e) { web = false; out = { text: await claude([{ type: 'text', text: prompt + '\n\n(Web search is unavailable: answer from your own knowledge.)' }], 3000), sources: [] }; }
    const j = parseJSON(out.text);
    const m = { id: 'm' + Date.now().toString(36), topic, title: String(j.title || topic).slice(0, 60), summary: String(j.summary || ''), steps: (j.steps || []).map(String).slice(0, 8), rules: (j.edit_rules || []).map(String).slice(0, 6), look: j.look ? safeLook(j.look) : null, sources: out.sources, web: web && out.sources.length > 0, on: true, at: Date.now() };
    await putIn('methods', m); await loadLibrary();
  } catch (e) { pstate.err = 'Research failed: ' + (e.message || e); }
  pstate.researching = ''; crewDone(['jason', 'lookdev']); paintP();
}
function paintP() { const p = $('#pane'); if (p && H()?.currentTab?.() === 'presets') presetsPane(p); }
export async function presetsPane(pane) {
  await loadLibrary(); const st = await storageLine();
  const groups = {}; PRESETS.forEach(p => (groups[p.kind] ||= []).push(p));
  const presetCard = p => `<div class="card" data-pid="${p.id}"><div class="top"><span class="who">${esc(p.name)}</span><span class="note">${KIND_LABEL[p.kind]} · ${mb(p.size)}</span></div>
      <span class="note">${esc(p.file)} · added by ${esc(p.by)} · ${new Date(p.at).toLocaleDateString()}${p.info ? '<br>' + esc(p.info) : ''}</span>
      <div class="row">${['lut', 'xmp'].includes(p.kind) ? `<button class="primary" data-default="${p.kind}:${p.id}">${defaultLook() === p.kind + ':' + p.id ? '✓ Default look' : 'Make default look'}</button>` : ''}<button data-dl>Download</button><button data-pdel>Delete</button></div></div>`;
  const methodCard = m => `<div class="card" data-mid="${m.id}"><div class="top"><span class="who">${esc(m.title)}</span><label class="note"><input type="checkbox" data-on ${m.on ? 'checked' : ''}> use in edits</label></div>
      <span class="note">${esc(m.summary)}</span>
      ${m.steps.length ? `<span class="eyebrow">How to do it</span>${m.steps.map((x, i) => `<span class="note">${i + 1}. ${esc(x)}</span>`).join('')}` : ''}
      ${m.rules.length ? `<span class="eyebrow">Rules the editor follows</span>${m.rules.map(x => `<span class="note">• ${esc(x)}</span>`).join('')}` : ''}
      ${m.look ? `<span class="note">Includes a grade: pick “Method · ${esc(m.title)}” as the look.</span>` : ''}
      <span class="note">${m.web ? 'Researched on the web:' : 'From Claude’s own knowledge (no live web search on this key).'}</span>
      ${m.sources.map(x => `<a class="note" href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.title.slice(0, 70))}</a>`).join('')}
      <div class="row"><button data-mdel>Delete</button></div></div>`;
  pane.innerHTML = `<span class="eyebrow">Presets & methods · Jason + Look Dev</span><h2>Presets library</h2>
    <p class="note">Drop LUTs, Lightroom presets, fonts, sound effects, overlays or project files. LUTs (.cube) are applied for real in the edit's color grade. Lightroom presets (.xmp) are converted into a look. Everything else is kept here, any size, for reference.</p>
    ${pstate.err ? `<p class="note" style="color:#E07A6A">${esc(pstate.err)}</p>` : ''}
    <label class="note" for="pFiles">Add files</label><input id="pFiles" type="file" multiple>
    ${pstate.busy ? `<p class="note">${esc(pstate.busy)}</p>` : ''}
    <p class="note">${esc(st)}</p>
    ${Object.keys(KIND_LABEL).filter(k => groups[k]).map(k => `<span class="eyebrow">${({ lut: 'LUTs', xmp: 'Lightroom presets', font: 'Fonts', audio: 'Sounds', video: 'Overlays & video', image: 'Images', project: 'Presets & project files', other: 'Other files' })[k]} · ${groups[k].length}</span>${groups[k].map(presetCard).join('')}`).join('') || '<p class="note">No presets yet.</p>'}
    <h2 style="margin-top:18px">Research a method</h2>
    <p class="note">Name a technique and Jason researches it, writes the steps, and turns it into rules every edit follows. Switch a method off to stop using it.</p>
    <div class="row"><input id="mTopic" type="text" placeholder="e.g. teal-orange golden hour hiking grade, J-cuts for vlogs" style="flex:1" ${pstate.researching ? 'disabled' : ''}><button class="primary" id="mGo" ${pstate.researching ? 'disabled' : ''}>${pstate.researching ? 'Researching…' : 'Research'}</button></div>
    ${pstate.researching ? `<p class="note">Jason is researching “${esc(pstate.researching)}”. This takes about a minute.</p>` : ''}
    ${METHODS.map(methodCard).join('') || '<p class="note">No methods yet.</p>'}`;
  $('#pFiles', pane).onchange = e => { const fs = [...e.target.files]; pstate.err = ''; if (fs.length) importPresets(fs); };
  const go = () => { const t = $('#mTopic', pane).value.trim(); if (t && !pstate.researching) researchMethod(t); };
  $('#mGo', pane).onclick = go; $('#mTopic', pane).onkeydown = e => { if (e.key === 'Enter') go(); };
  pane.querySelectorAll('[data-pid]').forEach(card => { const p = PRESETS.find(x => x.id === card.dataset.pid);
    card.querySelector('[data-default]')?.addEventListener('click', ev => { try { localStorage.setItem('sbdnj-default-look', ev.target.dataset.default); } catch {} paintP(); });
    card.querySelector('[data-dl]').onclick = () => { const a = document.createElement('a'); a.href = URL.createObjectURL(p.blob); a.download = p.file; a.click(); };
    card.querySelector('[data-pdel]').onclick = async () => { await delIn('presets', p.id); if (defaultLook().endsWith(p.id)) try { localStorage.removeItem('sbdnj-default-look'); } catch {} paintP(); }; });
  pane.querySelectorAll('[data-mid]').forEach(card => { const m = METHODS.find(x => x.id === card.dataset.mid);
    card.querySelector('[data-on]').onchange = async ev => { m.on = ev.target.checked; await putIn('methods', m); };
    card.querySelector('[data-mdel]').onclick = async () => { await delIn('methods', m.id); paintP(); }; });
}

// boot: add the Edit tab
(async () => {
  await refreshFinished();
  const style = document.createElement('style'); style.textContent = `#editBay{position:fixed;inset:0;z-index:600;background:rgba(0,0,0,.86);display:grid;place-items:center;padding:16px}
    #editBay .bayIn{width:min(560px,100%);display:flex;flex-direction:column;gap:10px;color:#F1ECE4;font-family:"JetBrains Mono",monospace}
    #bayCanvas{width:100%;max-height:70vh;object-fit:contain;background:#000;border-radius:10px}
    .pane input[type=file]{font-size:11px}`; document.head.appendChild(style);
  const tabs = document.querySelector('.tabs'); if (!tabs) return;
  const b = document.createElement('button'); b.setAttribute('role', 'tab'); b.dataset.tab = 'edit'; b.setAttribute('aria-selected', 'false'); b.textContent = 'Edit'; tabs.insertBefore(b, tabs.firstChild);
  b.addEventListener('click', () => { document.querySelectorAll('[data-tab]').forEach(x => x.setAttribute('aria-selected', String(x === b))); H()?.setTab?.('edit'); });
  const bp = document.createElement('button'); bp.setAttribute('role', 'tab'); bp.dataset.tab = 'presets'; bp.setAttribute('aria-selected', 'false'); bp.textContent = 'Presets'; tabs.insertBefore(bp, b.nextSibling);
  bp.addEventListener('click', () => { document.querySelectorAll('[data-tab]').forEach(x => x.setAttribute('aria-selected', String(x === bp))); H()?.setTab?.('presets'); });
  window.__extraTabs = { edit: editPane, presets: presetsPane };
  await loadLibrary();
  if (state.finished[0]?.kind === 'video') H()?.showFinished?.(URL.createObjectURL(state.finished[0].blob), state.finished[0].title);
})();
window.__edit = { gradePhoto, resolveLook, parseXMP };
