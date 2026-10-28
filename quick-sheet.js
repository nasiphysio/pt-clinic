// ═══════════════════════════════════════════════════════════
// Shortcut sheet — the clinic's one-page paper assessment
// (Nassef Center) with a mic next to every clinical field.
// It is saved as a normal visit (initial / follow-up) with the
// sheet's own fields under `visit.quick`, so the patient file,
// VAS chart, PDF and CSV keep working without changes.
// The full assessment is untouched; this is an extra button.
// ═══════════════════════════════════════════════════════════

const MODALITIES = ['TENS', 'US', 'Vib', 'HP', 'Needle', 'Mobilization'];
const KINDS = [['initial', 'Initial'], ['re1', 'Re-assessment 1'], ['re2', 'Re-assessment 2'], ['re3', 'Re-assessment 3']];
export const KIND_LABEL = Object.fromEntries(KINDS);

const STYLE = `
.qs-modal{max-width:760px}
.qs-head-tools{display:flex;gap:6px;align-items:center;margin-inline-start:auto;margin-inline-end:10px}
.qs-lang{display:inline-flex;border:1px solid var(--border);border-radius:20px;overflow:hidden}
.qs-lang button{border:0;background:transparent;padding:5px 11px;font:inherit;font-size:12px;font-weight:600;color:var(--muted);cursor:pointer}
.qs-lang button.on{background:var(--primary);color:#fff}
.qs-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px 14px}
.qs-f{display:flex;flex-direction:column;gap:4px;min-width:0}
.qs-f.wide{grid-column:1/-1}
.qs-f>label{font-size:12px;font-weight:600;color:var(--muted)}
.qs-in{display:flex;gap:6px;align-items:flex-start}
.qs-in .form-control{flex:1;min-width:0}
.qs-in textarea.form-control{min-height:64px}
.qs-mic{flex:0 0 auto;width:40px;height:40px;border-radius:50%;border:1px solid var(--border);background:var(--card);color:var(--primary);display:grid;place-items:center;cursor:pointer}
.qs-mic svg{width:18px;height:18px}
.qs-mic:focus-visible{outline:2px solid var(--primary);outline-offset:2px}
.qs-mic.rec{background:var(--red);border-color:var(--red);color:#fff;animation:qsPulse 1.1s infinite}
.qs-in.rec .form-control{border-color:var(--red);box-shadow:0 0 0 3px var(--red-light)}
@keyframes qsPulse{0%{box-shadow:0 0 0 0 rgba(217,79,79,.5)}100%{box-shadow:0 0 0 12px rgba(217,79,79,0)}}
.qs-info{display:grid;grid-template-columns:repeat(auto-fit,minmax(115px,1fr));gap:8px 14px;background:var(--bg);border-radius:var(--radius-sm);padding:10px 12px}
.qs-info-item{display:flex;flex-direction:column;min-width:0}
.qs-info-item span{font-size:11px;color:var(--muted);font-weight:600}
.qs-info-item b{font-size:14px;overflow-wrap:anywhere}
.qs-sep{border:0;border-top:1px solid var(--border);margin:16px 0}
.qs-kinds{display:flex;flex-wrap:wrap;gap:6px}
.qs-kinds button{border:1px solid var(--border);background:var(--card);border-radius:20px;padding:7px 14px;font:inherit;font-size:13px;cursor:pointer;color:var(--text)}
.qs-kinds button.on{background:var(--primary);border-color:var(--primary);color:#fff;font-weight:600}
.qs-kinds button:disabled{opacity:.4;cursor:not-allowed}
.qs-vas{display:grid;grid-template-columns:repeat(11,1fr);gap:4px;max-width:520px}
.qs-vas button{border:1px solid var(--border);background:var(--card);border-radius:6px;padding:8px 0;font:inherit;font-size:13px;font-weight:600;cursor:pointer;font-variant-numeric:tabular-nums;color:var(--text)}
.qs-vas button.on{color:#fff;border-color:transparent}
.qs-two{display:grid;grid-template-columns:1fr 1fr;gap:10px 14px;align-items:start}
@media (max-width:600px){.qs-two{grid-template-columns:1fr}}
.qs-chips{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px}
.qs-chips button{border:1px solid var(--border);background:var(--card);border-radius:20px;padding:7px 14px;font:inherit;font-size:13px;cursor:pointer;color:var(--text)}
.qs-chips button.on{background:var(--green-light);border-color:var(--green);color:#1e7d46;font-weight:600}
.qs-hint{font-size:12px;color:var(--muted);background:var(--bg);border-radius:var(--radius-sm);padding:8px 10px;margin-bottom:12px}
.qs-extra{display:flex;gap:12px;flex-wrap:wrap;align-items:flex-start;margin-top:8px}
.qs-extra .qs-meta{flex:1;min-width:180px;font-size:13px;display:grid;gap:4px}
.qs-badge{display:inline-block;background:#fff4dd;color:#9a6a00;border-radius:12px;padding:2px 10px;font-size:11px;font-weight:700}
`;

const MIC_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v4"/></svg>';

const vasColor = v => v <= 3 ? '#27ae60' : v <= 6 ? '#e8a020' : '#d94f4f';
const lines = t => String(t || '').split('\n').map(s => s.replace(/^[-•*\d.)\s]+/, '').trim()).filter(Boolean);

/**
 * deps: el, btn, showToast, errMsg, getPatient, todayStr, generateId, fmtDate,
 *       regionsOf, saveVisit(pid, visit, patientUpdates) -> Promise, afterSave(pid)
 */
export function setupQuickSheet(deps) {
  const { el, btn, showToast, errMsg, getPatient, todayStr, generateId, regionsOf, saveVisit, afterSave } = deps;

  if (!document.getElementById('qs-style')) {
    document.head.appendChild(el('style', { id: 'qs-style' }, STYLE));
  }

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let lang = 'ar';
  try { lang = localStorage.getItem('qs-lang') || 'ar'; } catch {}
  let rec = null, recBtn = null;

  function stopMic() { try { rec && rec.abort(); } catch {} }

  // Mic button for one field: tap, speak, the words are added to that field.
  function micFor(input, row, multiline) {
    const b = el('button', { type: 'button', class: 'qs-mic', title: 'Speak', 'aria-label': 'Speak into this field', html: MIC_SVG });
    b.addEventListener('click', () => {
      if (recBtn === b) { try { rec.stop(); } catch {} return; }
      stopMic();
      if (!SR) {
        input.focus();
        showToast('Voice typing is not available in this browser. Use the 🎤 on your keyboard.', true);
        return;
      }
      const r = new SR();
      r.lang = lang === 'ar' ? 'ar-EG' : 'en-US';
      r.interimResults = true;
      r.continuous = false;
      r.maxAlternatives = 1;
      const base = input.value.replace(/\s+$/, '');
      const sep = base ? (multiline ? '\n' : ' ') : '';
      r.onresult = e => {
        let txt = '';
        for (let i = 0; i < e.results.length; i++) txt += e.results[i][0].transcript;
        input.value = base + sep + txt.trim();
        input.dispatchEvent(new Event('input'));
      };
      r.onerror = e => {
        if (e.error === 'not-allowed' || e.error === 'service-not-allowed') showToast('Allow the microphone for this site, then try again.', true);
        else if (e.error === 'no-speech') showToast('No voice heard. Tap the mic and speak.', true);
        else if (e.error === 'network') showToast('Voice typing needs internet.', true);
      };
      r.onend = () => {
        b.classList.remove('rec'); row.classList.remove('rec');
        if (rec === r) { rec = null; recBtn = null; }
      };
      try {
        r.start();
        rec = r; recBtn = b;
        b.classList.add('rec'); row.classList.add('rec');
      } catch (e) { showToast('Could not start the mic. Try again.', true); }
    });
    return b;
  }

  // One labelled field. mic: add a mic button; area: textarea.
  function field(label, obj, key, { mic = false, area = false, type = 'text', wide = false, placeholder = '', rows = 3, dir = 'auto' } = {}) {
    const input = area
      ? el('textarea', { class: 'form-control', rows, placeholder, dir })
      : el('input', { class: 'form-control', type, placeholder, dir: type === 'text' ? dir : null });
    input.value = obj[key] ?? '';
    const sync = () => { obj[key] = input.value; };
    input.addEventListener('input', sync);
    input.addEventListener('change', sync);
    const row = el('div', { class: 'qs-in' }, input);
    if (mic) row.appendChild(micFor(input, row, area));
    const id = 'qs-' + key;
    input.id = id;
    return el('div', { class: 'qs-f' + (wide ? ' wide' : '') }, el('label', { for: id }, label), row);
  }

  function nextKind(p) {
    const qs = (p.visits || []).filter(v => v.quick);
    const hasInitial = (p.visits || []).some(v => v.type === 'initial');
    if (!hasInitial) return 'initial';
    const used = qs.map(v => v.quick.kind);
    return ['re1', 're2', 're3'].find(k => !used.includes(k)) || 're3';
  }

  function open(pid, visitId = null) {
    const p = getPatient(pid);
    if (!p) return;
    const existing = visitId ? (p.visits || []).find(v => v.id === visitId) : null;
    const otherInitial = (p.visits || []).find(v => v.type === 'initial' && v.id !== visitId);

    const S = existing?.quick ? JSON.parse(JSON.stringify(existing.quick)) : {
      kind: nextKind(p), onset: '', progression: '', ho: '', complaint: '', vas: null,
      diagnosis: '', problems: '', goals: '', modalities: [], treatment: '', note: ''
    };
    S.modalities = S.modalities || [];
    S.onset = S.onset ?? S.onsetDate ?? '';
    S.goals = S.goals || '';
    const info = { date: existing?.date || todayStr() };
    // A new re-assessment starts from the last sheet's onset, history, diagnosis, problems and goals.
    if (!existing && S.kind !== 'initial') {
      const prev = [...(p.visits || [])].filter(v => v.quick).sort((a, b) => (a.date || '').localeCompare(b.date || '')).pop();
      if (prev) for (const k of ['onset', 'ho', 'diagnosis', 'problems', 'goals']) S[k] = prev.quick[k] || (k === 'onset' ? prev.quick.onsetDate : '') || '';
    }

    const overlay = el('div', { class: 'modal-overlay dynamic open', style: 'z-index:250' });
    const close = () => { stopMic(); overlay.remove(); };

    // Header: title + language switch for the mic
    const langBox = el('div', { class: 'qs-lang', role: 'group', 'aria-label': 'Mic language' });
    const setLang = l => {
      lang = l; try { localStorage.setItem('qs-lang', l); } catch {}
      [...langBox.children].forEach(b => b.classList.toggle('on', b.dataset.l === l));
    };
    langBox.append(
      el('button', { type: 'button', 'data-l': 'ar', onclick: () => setLang('ar') }, 'عربي'),
      el('button', { type: 'button', 'data-l': 'en', onclick: () => setLang('en') }, 'English'));
    setLang(lang);

    const header = el('div', { class: 'modal-header' },
      el('div', { class: 'modal-title' }, '⚡ Assessment sheet — ' + p.name),
      el('div', { class: 'qs-head-tools' }, el('span', { style: 'font-size:12px;color:var(--muted)' }, '🎤'), langBox),
      el('button', { class: 'modal-close', type: 'button', onclick: close }, '✕'));

    const body = el('div', { class: 'modal-body' });
    body.appendChild(el('div', { class: 'qs-hint', dir: 'rtl' },
      'دوس 🎤 جنب أي خانة واتكلم، والكلام هيتكتب فيها. اختار "English" فوق لما تقول مصطلحات إنجليزي.'));

    // Patient info: entered by the receptionist, shown here read-only.
    const infoItem = (k, v) => el('div', { class: 'qs-info-item' }, el('span', {}, k), el('b', { dir: 'auto' }, v || '—'));
    body.appendChild(el('div', { class: 'qs-info' },
      infoItem('Name', p.name), infoItem('TEL', p.phone), infoItem('Age', p.age), infoItem('Occupation', p.job)));
    body.appendChild(el('div', { class: 'qs-grid', style: 'margin-top:10px;max-width:220px' },
      field('Assessment date', info, 'date', { type: 'date' })));

    body.appendChild(el('hr', { class: 'qs-sep' }));

    // Initial / re-assessment
    const kinds = el('div', { class: 'qs-kinds', role: 'group', 'aria-label': 'Assessment type' });
    const drawKinds = () => {
      kinds.innerHTML = '';
      KINDS.forEach(([k, l]) => {
        const disabled = k === 'initial' && !!otherInitial;
        kinds.appendChild(el('button', { type: 'button', class: S.kind === k ? 'on' : '', disabled, title: disabled ? 'This patient already has an initial assessment' : null,
          onclick: () => { S.kind = k; drawKinds(); } }, l));
      });
    };
    drawKinds();
    body.appendChild(kinds);

    body.appendChild(el('div', { class: 'qs-grid', style: 'margin-top:12px' },
      field('Onset', S, 'onset', { mic: true, wide: true }),
      field('Progression', S, 'progression', { mic: true, wide: true }),
      field('H/O', S, 'ho', { mic: true, wide: true }),
      field('Chief complaint', S, 'complaint', { mic: true, area: true, wide: true, rows: 2 })));

    // VAS 0-10
    const vas = el('div', { class: 'qs-vas', role: 'group', 'aria-label': 'Pain VAS 0 to 10' });
    const drawVas = () => {
      vas.innerHTML = '';
      for (let i = 0; i <= 10; i++) {
        const on = S.vas === i;
        vas.appendChild(el('button', { type: 'button', class: on ? 'on' : '', style: on ? `background:${vasColor(i)}` : null,
          onclick: () => { S.vas = S.vas === i ? null : i; drawVas(); } }, i));
      }
    };
    drawVas();
    body.appendChild(el('div', { class: 'qs-f', style: 'margin-top:12px' }, el('label', {}, 'Pain (VAS 0–10)'), vas));

    body.appendChild(el('div', { class: 'qs-grid', style: 'margin-top:12px' },
      field('Diagnosis', S, 'diagnosis', { mic: true, wide: true })));

    // Problem list + treatment goals side by side (stacked on a phone)
    body.appendChild(el('div', { class: 'qs-two', style: 'margin-top:12px' },
      field('Problem list (one per line)', S, 'problems', { mic: true, area: true, rows: 6 }),
      field('Treatment goals', S, 'goals', { mic: true, area: true, rows: 6 })));

    // Treatment
    const chips = el('div', { class: 'qs-chips', role: 'group', 'aria-label': 'Treatment modalities' });
    const drawChips = () => {
      chips.innerHTML = '';
      MODALITIES.forEach(m => chips.appendChild(el('button', { type: 'button', class: S.modalities.includes(m) ? 'on' : '', 'aria-pressed': String(S.modalities.includes(m)),
        onclick: () => { S.modalities = S.modalities.includes(m) ? S.modalities.filter(x => x !== m) : [...S.modalities, m]; drawChips(); } },
        (S.modalities.includes(m) ? '✓ ' : '') + m)));
    };
    drawChips();
    body.appendChild(el('hr', { class: 'qs-sep' }));
    body.appendChild(el('div', { class: 'qs-f' }, el('label', {}, 'Treatment'), chips));
    body.appendChild(el('div', { class: 'qs-grid' },
      field('Treatment details (exercises, parameters…)', S, 'treatment', { mic: true, area: true, wide: true, rows: 4 }),
      field('Note', S, 'note', { mic: true, area: true, wide: true, rows: 2 })));

    // Footer
    const saveBtn = btn('💾 Save', 'btn-primary', async () => {
      stopMic();
      const fresh = getPatient(pid) || p;
      const type = S.kind === 'initial' ? 'initial' : 'followup';
      if (type === 'initial' && (fresh.visits || []).some(v => v.type === 'initial' && v.id !== visitId)) {
        showToast('This patient already has an initial assessment — choose a re-assessment.', true); return;
      }
      const region = existing?.regions?.[0]?.region || regionsOf(fresh)[0] || 'General';
      const quick = { ...S, problems: (S.problems || '').trim(), treatment: (S.treatment || '').trim() };
      const visit = {
        id: existing?.id || generateId(), type, date: info.date || todayStr(),
        duration: (S.onset || '').trim(), onset: '', progress: '',
        notes: [S.ho && 'H/O: ' + S.ho.trim(), (S.note || '').trim()].filter(Boolean).join('\n'),
        goalsShort: (S.goals || '').trim(), goalsLong: '', measures: [],
        regions: [{
          region, diagnoses: S.diagnosis.trim() ? [S.diagnosis.trim()] : [], complaints: S.complaint.trim() ? [S.complaint.trim()] : [],
          findings: [], problems: lines(S.problems), treatment: [...S.modalities, ...lines(S.treatment)],
          vas: S.vas, measurements: '', sessionsPlanned: existing?.regions?.[0]?.sessionsPlanned || '', freq: existing?.regions?.[0]?.freq || ''
        }],
        quick, savedAt: Date.now()
      };
      delete quick.onsetDate; delete quick.marks;
      saveBtn.disabled = true;
      try {
        await saveVisit(pid, visit, {});
        close();
        showToast(`${KIND_LABEL[S.kind]} saved ✅`);
        afterSave(pid);
      } catch (e) { showToast(errMsg(e), true); }
      finally { saveBtn.disabled = false; }
    });
    const footer = el('div', { class: 'modal-footer' }, btn('Cancel', 'btn-ghost', close), saveBtn);

    overlay.appendChild(el('div', { class: 'modal qs-modal' }, header, body, footer));
    document.body.appendChild(overlay);
  }

  // Extra lines shown on a saved sheet in the patient file.
  function extras(v) {
    const q = v.quick;
    const meta = el('div', { class: 'qs-meta' },
      el('div', {}, el('span', { class: 'qs-badge' }, '⚡ ' + (KIND_LABEL[q.kind] || 'Sheet'))),
      (q.onset || q.onsetDate) ? el('div', {}, el('b', {}, 'Onset: '), q.onset || q.onsetDate) : null,
      q.progression ? el('div', {}, el('b', {}, 'Progression: '), q.progression) : null,
      (q.modalities || []).length ? el('div', {}, el('b', {}, 'Modalities: '), q.modalities.join(', ')) : null);
    return el('div', { class: 'qs-extra' }, meta);
  }

  return { open, extras };
}
