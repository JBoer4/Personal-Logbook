import { useState, useEffect, useRef } from 'preact/hooks';
import { html } from 'htm/preact';
import { db } from '../db.js';
import { navigate } from '../router.js';
import { syncAfterMutation } from '../sync.js';
import { uuid, now, formatShort, parseTags, isNoteExpired, today } from '../utils.js';

export function People({ budgetId }) {
  const [list, setList] = useState(null); // the people-list budget record
  const [people, setPeople] = useState([]);
  const [noteInfo, setNoteInfo] = useState({}); // personId -> {count, lastNoteAt, lastNoteText}
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [chip, setChip] = useState(null); // null | {person} | {isNew: true, name}
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [activeTag, setActiveTag] = useState(null);
  const [editingTitle, setEditingTitle] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const inputRef = useRef(null);
  const titleRef = useRef(null);

  async function load() {
    const [budget, allPeople, notes] = await Promise.all([
      db.getBudget(budgetId), db.getPeople(), db.getAllPersonNotes(),
    ]);
    const ppl = allPeople.filter(p => p.budgetId === budgetId);
    const ids = new Set(ppl.map(p => p.id));
    const todayStr = today();
    const info = {};
    for (const n of notes) {
      if (!ids.has(n.personId) || isNoteExpired(n, todayStr)) continue;
      const cur = info[n.personId] || { count: 0, lastNoteAt: 0, lastNoteText: '' };
      cur.count++;
      if (n.createdAt > cur.lastNoteAt) {
        cur.lastNoteAt = n.createdAt;
        cur.lastNoteText = n.text;
      }
      info[n.personId] = cur;
    }
    setList(budget || null);
    setPeople(ppl);
    setNoteInfo(info);
    setLoading(false);
  }

  useEffect(() => { setLoading(true); load(); }, [budgetId]);

  async function renameList(newName) {
    setEditingTitle(false);
    if (!list || !newName.trim() || newName.trim() === list.name) return;
    const updated = { ...list, name: newName.trim(), updatedAt: now() };
    delete updated._dirty;
    await db.putBudget(updated);
    setList(updated);
    syncAfterMutation();
  }

  async function deleteList() {
    const ts = now();
    const notes = await db.getAllPersonNotes();
    const ids = new Set(people.map(p => p.id));
    for (const n of notes) {
      if (ids.has(n.personId)) await db.deletePersonNote(n.id, ts);
    }
    for (const p of people) await db.deletePerson(p.id, ts);
    await db.deleteBudget(budgetId, ts);
    syncAfterMutation();
    navigate('/');
  }

  // Distinct tags across this list (case-insensitive dedupe, keep first spelling)
  const allTags = [];
  for (const p of people) {
    for (const t of parseTags(p.tag)) {
      if (!allTags.some(x => x.toLowerCase() === t.toLowerCase())) allTags.push(t);
    }
  }
  allTags.sort((a, b) => a.localeCompare(b));

  const trimmed = query.trim();
  const lower = trimmed.toLowerCase();
  const matches = people.filter(p => {
    const tags = parseTags(p.tag);
    if (activeTag && !tags.some(t => t.toLowerCase() === activeTag.toLowerCase())) return false;
    if (!lower) return true;
    return p.name.toLowerCase().includes(lower) || tags.some(t => t.toLowerCase().includes(lower));
  });

  const sorted = [...matches].sort((a, b) => {
    const aAt = noteInfo[a.id]?.lastNoteAt ?? a.createdAt;
    const bAt = noteInfo[b.id]?.lastNoteAt ?? b.createdAt;
    return bAt - aAt;
  });

  function selectPerson(person) {
    setChip({ person });
    setQuery('');
    setDropdownOpen(false);
    inputRef.current?.focus();
  }

  function selectCreate() {
    if (!trimmed) return;
    setChip({ isNew: true, name: trimmed });
    setQuery('');
    setDropdownOpen(false);
    inputRef.current?.focus();
  }

  function clearChip() {
    setChip(null);
    setQuery('');
    inputRef.current?.focus();
  }

  async function saveNote() {
    const text = query.trim();
    if (!chip || !text) return;
    const ts = now();
    let personId;
    if (chip.isNew) {
      personId = uuid();
      await db.putPerson({ id: personId, budgetId, name: chip.name, tag: null, createdAt: ts, updatedAt: ts });
    } else {
      personId = chip.person.id;
    }
    await db.putPersonNote({ id: uuid(), personId, text, pinned: 0, expiresAt: null, remindOn: null, repeatYearly: 0, createdAt: ts, updatedAt: ts });
    setChip(null);
    setQuery('');
    await load();
    syncAfterMutation();
  }

  function onKeyDown(e) {
    if (chip) {
      if (e.key === 'Enter') saveNote();
      if (e.key === 'Escape') clearChip();
      return;
    }
    if (e.key === 'Escape') setDropdownOpen(false);
    if (e.key === 'Enter') {
      if (matches.length > 0 && trimmed) selectPerson(matches[0]);
      else if (trimmed) selectCreate();
    }
  }

  if (loading) return html`<div class="loading">Loading...</div>`;

  return html`
    <div class="people-view">
      <div class="budget-title-row">
        ${editingTitle ? html`
          <input class="budget-title-input" type="text" ref=${titleRef}
            value=${list?.name || ''}
            onKeyDown=${(e) => { if (e.key === 'Enter') renameList(e.target.value); if (e.key === 'Escape') setEditingTitle(false); }}
            onBlur=${(e) => renameList(e.target.value)} />
        ` : html`
          <h2 class="budget-title" onClick=${() => { setEditingTitle(true); setTimeout(() => titleRef.current?.select(), 0); }}>
            ${list?.name || 'People'}
          </h2>
        `}
        <button class="budget-delete-btn" onClick=${() => setConfirmDelete(true)}>Delete</button>
      </div>

      ${confirmDelete && html`
        <div class="confirm-bar">
          <span>Delete this list and everyone in it?</span>
          <button class="btn btn-danger" onClick=${deleteList}>Yes, delete</button>
          <button class="btn btn-secondary" onClick=${() => setConfirmDelete(false)}>Cancel</button>
        </div>
      `}

      <div class="people-quickadd">
        <div class="qa-input-wrap">
          ${chip && html`
            <span class="qa-chip">
              ${chip.isNew ? chip.name : chip.person.name}
              <button class="qa-chip-x" onClick=${clearChip}>×</button>
            </span>
          `}
          <input class="qa-input" type="text" ref=${inputRef}
            value=${query}
            placeholder=${chip ? `Note about ${chip.isNew ? chip.name : chip.person.name}…` : 'Who did you talk to?'}
            autocomplete="off"
            autocapitalize=${chip ? 'sentences' : 'words'}
            enterkeyhint=${chip ? 'send' : 'go'}
            onInput=${(e) => { setQuery(e.target.value); if (!chip) setDropdownOpen(true); }}
            onKeyDown=${onKeyDown} />
          ${chip && html`
            <button class="btn qa-save" disabled=${!trimmed} onClick=${saveNote}>Save</button>
          `}
        </div>
        ${!chip && dropdownOpen && trimmed && html`
          <div class="qa-dropdown">
            ${matches.map(p => html`
              <button class="qa-option" key=${p.id}
                onMouseDown=${(e) => { e.preventDefault(); selectPerson(p); }}>
                ${p.name}
                ${parseTags(p.tag).length > 0 && html`<span class="qa-option-tag">${parseTags(p.tag).join(' · ')}</span>`}
              </button>
            `)}
            <button class="qa-option qa-option-create"
              onMouseDown=${(e) => { e.preventDefault(); selectCreate(); }}>
              ＋ Create “${trimmed}”
            </button>
          </div>
        `}
      </div>

      ${allTags.length > 0 && html`
        <div class="tag-filter-row">
          ${allTags.map(t => html`
            <button class="tag-filter-chip ${activeTag?.toLowerCase() === t.toLowerCase() ? 'active' : ''}" key=${t}
              onClick=${() => setActiveTag(activeTag?.toLowerCase() === t.toLowerCase() ? null : t)}>
              ${t}
            </button>
          `)}
        </div>
      `}

      ${people.length === 0 ? html`
        <div class="empty-state">No people yet — type a name above to jot your first note.</div>
      ` : sorted.length === 0 ? html`
        <div class="empty-state">No matches</div>
      ` : html`
        <div class="people-list">
          ${sorted.map(p => {
            const info = noteInfo[p.id];
            const tags = parseTags(p.tag);
            return html`
              <button class="person-row" key=${p.id} onClick=${() => navigate(`/budget/${budgetId}/person/${p.id}`)}>
                <div class="person-row-main">
                  <span class="person-row-name">${p.name}</span>
                  ${tags.map(t => html`<span class="person-row-tag" key=${t}>${t}</span>`)}
                  <span class="person-row-meta">
                    ${info ? `${formatShort(info.lastNoteAt)} · ${info.count}` : ''}
                  </span>
                </div>
                ${info?.lastNoteText && html`<div class="person-row-snippet">${info.lastNoteText}</div>`}
              </button>
            `;
          })}
        </div>
      `}
    </div>
  `;
}
