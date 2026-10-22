// ShotByDNJ Studio — Learning tab.
// The studio studies trusted sources, grades Dag's posts against what's performing, turns that into
// recipes (what to shoot + how to edit), and practices new techniques every night. All of it lives in
// lab/lab.json + lab/posts/ in this repo; the nightly task commits updates there.
const esc = x => String(x ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safe = u => (typeof u === 'string' && (/^lab\/[\w./-]+$/.test(u) || u.startsWith('https://'))) ? u : '';
const link = (s) => s && safe(s.url) ? `<a href="${esc(safe(s.url))}" target="_blank" rel="noopener" style="color:inherit">${esc(s.name)}</a>` : esc(s?.name || '');
const fmtK = n => n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, '') + 'K' : String(n);
const pct = (a, b) => a == null || !b ? '–' : (a / b * 100).toFixed(a / b < 0.01 ? 2 : 1) + '%';
const H = () => window.__hq;
let lab = null, err = '', view = 'style', recipeId = 'house', applying = false, applied = null;
try { view = localStorage.getItem('sbdnj-learn-view') || 'style'; recipeId = localStorage.getItem('sbdnj-recipe') || 'house'; } catch {}

async function load() {
  try {
    const r = await fetch('lab/lab.json?t=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) throw new Error(r.status);
    lab = await r.json(); err = '';
  } catch { err = 'The learning log could not load. Check your connection and reopen the tab.'; }
}

function bar(v, max = 5) { return `<span class="lbar" aria-hidden="true"><i style="width:${(v / max) * 100}%"></i></span>`; }

function viewStyle() {
  const pr = lab.profile || {}, posts = (lab.posts || []).slice().sort((a, b) => b.views - a.views), rub = lab.rubric || [];
  return `
    <div class="card"><span class="who">Your style</span><span>${esc(pr.summary)}</span>
      ${(pr.signature || []).map(s => `<span>· ${esc(s)}</span>`).join('')}</div>
    <span class="eyebrow">What's working for you</span>
    ${(pr.findings || []).map(f => `<div class="card"><span>${esc(f.text)}</span><span class="note">${f.url ? `<a href="${esc(safe(f.url))}" target="_blank" rel="noopener" style="color:inherit">${esc(f.basis)}</a>` : esc(f.basis)}</span></div>`).join('')}
    <span class="eyebrow">Your posts, graded</span>
    <span class="note">Each post scored 1–5 on six things the sources say matter (max 30). Sorted by views so you can see where the grade and the numbers agree.</span>
    ${posts.map(p => `<div class="card">
      ${p.img ? `<img src="${esc(safe(p.img))}" alt="${esc(p.title)}" loading="lazy" style="width:100%;border-radius:8px">` : ''}
      <div class="top"><span class="who">${esc(p.title)}</span><span class="when">${esc(p.date)}</span></div>
      <span class="note">${esc(p.format)} · ${fmtK(p.views)} views · ${pct(p.likes, p.views)} likes/view · ${pct(p.sends, p.views)} sends/view</span>
      ${p.grade ? `<div class="grades">${rub.map(r => `<span>${esc(r.name)}</span>${bar(p.grade[r.key])}<b>${p.grade[r.key]}</b>`).join('')}</div><span class="note">Score <b>${p.score}/30</b></span>` : '<span class="note">Not graded</span>'}
      <span>${esc(p.note)}</span></div>`).join('')}
    <span class="eyebrow">How the grade works</span>
    ${rub.map(r => `<div class="card"><span class="who">${esc(r.name)}</span><span>${esc(r.what)}</span>${r.source ? `<span class="note">Source: ${link(r.source)}</span>` : ''}</div>`).join('')}
    <span class="eyebrow">Built around your gear</span>
    <div class="card"><span>${esc(lab.gear)}</span>${(pr.limits || []).map(s => `<span>· ${esc(s)}</span>`).join('')}</div>
    <span class="note">To add posts: send screenshots of your posts with views showing in chat. Instagram doesn't let apps read your account directly.</span>`;
}

function promptFor(r) {
  return `Edit this with my @shotbydnj "${r.name}" recipe. Shoot notes: ${r.shoot.join(' ')} Edit: ${r.edit.join(' ')} Follow my house style: natural, don't darken the sky, keep my framing, true-to-life greens.`;
}
function viewRecipes() {
  const rs = lab.recipes || []; const r = rs.find(x => x.id === recipeId) || rs[0]; if (!r) return '';
  return `
    <span class="note">Pick the look you want. You get what to shoot, how to edit it in Lightroom, why, and a button that edits your photo for you.</span>
    <div class="chips">${rs.map(x => `<button data-recipe="${esc(x.id)}" aria-pressed="${x.id === r.id}">${esc(x.name)}</button>`).join('')}</div>
    <div class="card"><span class="who" style="font-size:14px">${esc(r.name)}</span><span class="note">${esc(r.when)}</span>
      <span><b>Doing well:</b> ${esc(r.doing_well)}</span></div>
    <div class="card"><span class="who">When you shoot</span>${r.shoot.map(s => `<span>· ${esc(s)}</span>`).join('')}</div>
    <div class="card"><span class="who">In Lightroom</span>${r.edit.map(s => `<span>· ${esc(s)}</span>`).join('')}</div>
    <div class="card"><span class="who">Why</span><span>${esc(r.why)}</span>
      <span class="note">Sources: ${[r.source, ...(r.also || [])].filter(Boolean).map(link).join(' · ')}</span></div>
    <div class="card"><span class="who">Apply to my photo</span>
      <span class="note">Runs on your phone. You get a full-size master and a 4:5 feed version.</span>
      <label for="rFile" class="dropbox"><b>${applying ? 'Editing…' : 'Pick a photo'}</b><span class="note">JPG, PNG or HEIC from your camera roll</span></label>
      <input id="rFile" type="file" accept="image/*" hidden ${applying ? 'disabled' : ''}>
      <p class="note" id="rMsg"></p>
      ${applied ? `<div class="media"><img src="${applied.before}" alt="Before"><img src="${applied.after}" alt="After: ${esc(applied.name)}"></div>
        <span class="note">Before · After (${esc(applied.name)})</span>
        <div style="display:flex;gap:6px;flex-wrap:wrap"><button id="rSaveFeed">Save 4:5 feed</button><button id="rSaveMaster">Save full size</button></div>` : ''}</div>
    <div class="card"><span class="who">Prompt for Claude</span><span class="note">Paste this in chat with your photo or clips for a full edit.</span>
      <textarea id="rPrompt" readonly rows="4">${esc(promptFor(r))}</textarea><button id="rCopy">Copy prompt</button></div>`;
}

function viewLearning() {
  const p = lab.practice || [], r = lab.research || [], pb = lab.playbook || [];
  return `
    <div class="card"><span>The studio is always learning. Every night it reads one new technique from a trusted source, practices it on one of your photos, and logs the result. What works goes into the playbook and the recipes.</span>
      <span class="note">${r.length} lessons · ${p.length} practice tests · ${pb.length} in the playbook</span></div>
    <span class="eyebrow">Studio team · ${(lab.hires || []).length} hired from learning</span>
    <span class="note">When the studio learns enough in one area, it hires a specialist. You'll see them at the back of the Editing Bullpen.</span>
    ${(lab.hires || []).map(x => `<div class="card"><div class="top"><span class="who">${esc(x.name)}</span><span class="when">Hired ${esc(x.hired)}</span></div>
      <span class="note">${esc(x.role)}</span><span>${esc(x.why)}</span></div>`).join('')}
    <span class="eyebrow">Daily breakdown</span>
    ${(lab.reports || []).slice(0, 7).map(x => `<div class="card"><div class="top"><span class="who">${esc(x.headline)}</span><span class="when">${esc(x.date)}</span></div>
      ${x.added?.length ? `<span><b>Hired:</b> ${x.added.map(esc).join(', ')}</span>` : '<span class="note">No new hires</span>'}
      <span><b>Learned:</b></span>${(x.learned || []).map(l => `<span>· ${esc(l.title)} <span class="note">(${link({ name: l.source, url: l.url })})</span></span>`).join('')}
      <span><b>Try it yourself:</b></span>${(x.try || []).map(t => `<span>· ${esc(t)}</span>`).join('')}
      <span><b>How the studio tested it:</b> ${esc(x.tested)}</span></div>`).join('') || '<div class="card"><span class="note">The first breakdown lands after tonight\'s session.</span></div>'}
    <span class="eyebrow">Studio team · ${(lab.hires || []).length} hired from learning</span>
    <span class="note">When the studio learns enough in one area, it hires a specialist. They sit in the Learning Lab wing, which grows a new bay every 4 hires.</span>
    ${(lab.hires || []).map(x => `<div class="card"><div class="top"><span class="who">${esc(x.name)}</span><span class="when">Hired ${esc(x.hired)}</span></div>
      <span class="note">${esc(x.role)}</span><span>${esc(x.why)}</span></div>`).join('')}
    <span class="eyebrow">Studying</span>
    ${r.map(x => `<div class="card"><div class="top"><span class="who">${esc(x.title)}</span><span class="when">${esc(x.date)}</span></div>
      <span>${esc(x.takeaway)}</span><span class="note">Source: ${link({ name: x.source, url: x.url })}</span></div>`).join('') || '<div class="card"><span class="note">Tonight\'s reading shows here.</span></div>'}
    <span class="eyebrow">Practice tests</span>
    ${p.map(x => `<div class="card"><div class="top"><span class="who">${esc(x.technique)}</span><span class="when">${esc(x.date)} · ${esc(x.photo)}</span></div>
      <div class="media"><img src="${esc(safe(x.before))}" alt="Before" loading="lazy"><img src="${esc(safe(x.after))}" alt="After" loading="lazy"></div>
      <span class="note">Before · After · studio ${x.verdict === 'kept' ? 'kept it' : 'dropped it'}</span>
      <span>${esc(x.note)}</span>${x.source ? `<span class="note">Learned from: ${link({ name: x.source, url: x.source_url })}</span>` : ''}</div>`).join('')}
    <span class="eyebrow">Playbook</span>
    ${pb.map(x => `<div class="card"><span class="who">${esc(x.title)}</span><span>${esc(x.how)}</span><span class="note">${esc(x.from)}</span></div>`).join('')}
    <span class="eyebrow">House style</span>
    <div class="card">${(lab.style || []).map(s => `<span>· ${esc(s)}</span>`).join('')}</div>
    <span class="note">Last updated ${esc(new Date(lab.updated).toLocaleString())}</span>`;
}

function pane(el) {
  if (!lab) { el.innerHTML = `<div class="card"><span class="note">${esc(err || 'Loading what the studio has learned…')}</span></div>`; if (!err) load().then(() => { if (H()?.currentTab?.() === 'learn') pane(el); }); return; }
  el.innerHTML = `<span class="eyebrow">Always learning</span>
    <div class="chips" role="tablist">${[['style', 'My style'], ['recipes', 'Recipes'], ['learning', 'Studio learning']].map(([k, n]) => `<button data-view="${k}" aria-pressed="${view === k}">${n}</button>`).join('')}</div>
    ${view === 'recipes' ? viewRecipes() : view === 'learning' ? viewLearning() : viewStyle()}`;
  el.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', () => { view = b.dataset.view; try { localStorage.setItem('sbdnj-learn-view', view); } catch {} pane(el); el.scrollTop = 0; }));
  el.querySelectorAll('[data-recipe]').forEach(b => b.addEventListener('click', () => { recipeId = b.dataset.recipe; applied = null; try { localStorage.setItem('sbdnj-recipe', recipeId); } catch {} pane(el); }));
  const copy = el.querySelector('#rCopy');
  if (copy) copy.addEventListener('click', async () => { const t = el.querySelector('#rPrompt'); try { await navigator.clipboard.writeText(t.value); copy.textContent = 'Copied'; } catch { t.select(); copy.textContent = 'Selected, tap Copy'; } });
  const file = el.querySelector('#rFile');
  if (file) file.addEventListener('change', () => applyRecipe(el, file.files?.[0]));
  const sf = el.querySelector('#rSaveFeed'), sm = el.querySelector('#rSaveMaster'), ed = window.__edit;
  if (sf && applied) sf.addEventListener('click', () => ed?.shareOrSave?.(applied.feed, `shotbydnj_${recipeId}_4x5.jpg`, 'Edited in ShotByDNJ Studio'));
  if (sm && applied) sm.addEventListener('click', () => ed?.shareOrSave?.(applied.master, `shotbydnj_${recipeId}.jpg`, 'Edited in ShotByDNJ Studio'));
}

async function applyRecipe(el, f) {
  if (!f || applying) return;
  const r = (lab.recipes || []).find(x => x.id === recipeId); const ed = window.__edit;
  const msg = () => el.querySelector('#rMsg');
  if (!ed?.gradePhoto) { if (msg()) msg().textContent = 'The editor is still loading. Try again in a few seconds.'; return; }
  applying = true; pane(el); if (msg()) msg().textContent = 'Editing on your phone…';
  try {
    const { master, feed } = await ed.gradePhoto(f, { ...r.look, name: r.name });
    if (applied) { URL.revokeObjectURL(applied.before); URL.revokeObjectURL(applied.after); }
    applied = { name: r.name, master, feed, before: URL.createObjectURL(f), after: URL.createObjectURL(feed) };
    H()?.log?.(`<b>Colorist</b> applied the ${esc(r.name)} recipe to your photo`, true);
  } catch (e) { applied = null; applying = false; pane(el); const m = msg(); if (m) m.textContent = "Couldn't edit that photo. Try a JPG under 30 MB."; return; }
  applying = false; if (H()?.currentTab?.() === 'learn') pane(el);
}

(async () => {
  const style = document.createElement('style');
  style.textContent = `.pane .chips{display:flex;flex-wrap:wrap;gap:6px}
    .pane .grades{display:grid;grid-template-columns:auto 1fr auto;gap:2px 8px;align-items:center;font-size:11px}
    .pane .lbar{height:5px;border-radius:3px;background:rgba(255,255,255,.08);overflow:hidden}
    .pane .lbar i{display:block;height:100%;background:var(--cool)}
    .pane textarea[readonly]{width:100%;font-size:11px}`;
  document.head.appendChild(style);
  for (let i = 0; i < 80 && !window.__extraTabs; i++) await new Promise(r => setTimeout(r, 100));
  const tabs = document.querySelector('.tabs'); if (!tabs) return;
  const b = document.createElement('button'); b.setAttribute('role', 'tab'); b.dataset.tab = 'learn'; b.setAttribute('aria-selected', 'false'); b.textContent = 'Learning';
  const presets = tabs.querySelector('[data-tab="presets"]'); tabs.insertBefore(b, presets ? presets.nextSibling : tabs.firstChild);
  b.addEventListener('click', () => { document.querySelectorAll('[data-tab]').forEach(x => x.setAttribute('aria-selected', String(x === b))); H()?.setTab?.('learn'); });
  window.__extraTabs = Object.assign(window.__extraTabs || {}, { learn: pane });
  await load();
  const last = lab?.research?.[lab.research.length - 1];
  if (last) H()?.log?.(`<b>Studio</b> studied ${esc(last.title)} · ${esc(last.source)}`, true);
  const t = lab?.practice?.[0];
  if (t) H()?.log?.(`<b>Studio</b> practiced ${esc(t.technique)} on ${esc(t.photo)} · ${t.verdict === 'kept' ? 'kept it' : 'dropped it'}`, true);
})();
