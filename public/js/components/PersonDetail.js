import { useState, useEffect, useRef } from 'preact/hooks';
import { html } from 'htm/preact';
import { db } from '../db.js';
import { navigate } from '../router.js';
import { syncAfterMutation, debouncedSync } from '../sync.js';
import { uuid, now, formatShort, parseDate, parseTags, isNoteExpired, today } from '../utils.js';

function formatNoteDate(ts) {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${formatShort(d)} ${hh}:${mm}`;
}

export function PersonDetail({ budgetId, personId }) {
  const [person, setPerson] = useState(null);
  const [notes, setNotes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editingName, setEditingName] = useState(false);
  const [editingTag, setEditingTag] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [newNote, setNewNote] = useState('');
  const [editingNoteId, setEditingNoteId] = useState(null);
  const [noteDraft, setNoteDraft] = useState('');
  const [dateEditorId, setDateEditorId] = useState(null);
  const [showExpired, setShowExpired] = useState(false);
  const nameRef = useRef(null);
  const tagRef = useRef(null);

  async function load() {
    const [p, ns] = await Promise.all([db.getPerson(personId), db.getPersonNotes(personId)]);
    ns.sort((a, b) => b.createdAt - a.createdAt);
    setPerson(p || null);
    setNotes(ns);
    setLoading(false);
  }

  useEffect(() => { setLoading(true); load(); }, [personId]);

  async function savePerson(updates) {
    const updated = { ...person, ...updates, updatedAt: now() };
    await db.putPerson(updated);
    setPerson(updated);
    debouncedSync();
  }

  function renamePerson(newName) {
    setEditingName(false);
    if (!newName.trim() || newName.trim() === person.name) return;
    savePerson({ name: newName.trim() });
  }

  function retagPerson(raw) {
    setEditingTag(false);
    const tag = parseTags(raw).join(', ') || null;
    if (tag === person.tag) return;
    savePerson({ tag });
  }

  async function addNote() {
    const text = newNote.trim();
    if (!text) return;
    const ts = now();
    const note = { id: uuid(), personId, text, pinned: 0, expiresAt: null, remindOn: null, repeatYearly: 0, createdAt: ts, updatedAt: ts };
    await db.putPersonNote(note);
    setNotes([note, ...notes]);
    setNewNote('');
    syncAfterMutation();
  }

  async function saveNote(note, updates) {
    const updated = { ...note, ...updates, updatedAt: now() };
    await db.putPersonNote(updated);
    setNotes(notes.map(n => n.id === note.id ? updated : n));
    debouncedSync();
  }

  function togglePin(note) {
    saveNote(note, { pinned: note.pinned ? 0 : 1 });
  }

  function finishNoteEdit(note) {
    setEditingNoteId(null);
    const text = noteDraft.trim();
    if (!text || text === note.text) return;
    saveNote(note, { text });
  }

  async function removeNote(note) {
    await db.deletePersonNote(note.id, now());
    setNotes(notes.filter(n => n.id !== note.id));
    syncAfterMutation();
  }

  async function deletePerson() {
    const ts = now();
    for (const n of notes) await db.deletePersonNote(n.id, ts);
    await db.deletePerson(personId, ts);
    syncAfterMutation();
    navigate('/budget/' + budgetId);
  }

  if (loading) return html`<div class="loading">Loading...</div>`;

  if (!person) return html`
    <div class="empty-state">
      Person not found
      <button class="btn btn-secondary" onClick=${() => navigate('/budget/' + budgetId)}>Back to People</button>
    </div>
  `;

  const todayStr = today();
  const expired = notes.filter(n => isNoteExpired(n, todayStr));
  const facts = notes.filter(n => n.pinned && !isNoteExpired(n, todayStr));
  const timeline = notes.filter(n => !n.pinned && !isNoteExpired(n, todayStr));
  const tags = parseTags(person.tag);

  const noteRow = (note, rowClass) => html`
    <div class=${rowClass} key=${note.id}>
      ${editingNoteId === note.id ? html`
        <input class="note-edit-input" type="text" value=${noteDraft}
          ref=${(el) => el && el.focus()}
          onInput=${(e) => setNoteDraft(e.target.value)}
          onKeyDown=${(e) => {
            if (e.key === 'Enter') finishNoteEdit(note);
            if (e.key === 'Escape') setEditingNoteId(null);
          }}
          onBlur=${() => finishNoteEdit(note)} />
      ` : html`
        <span class="note-text" onClick=${() => { setEditingNoteId(note.id); setNoteDraft(note.text); }}>
          ${note.text}
        </span>
      `}
      <div class="note-actions">
        <span class="note-date">
          ${formatNoteDate(note.createdAt)}
          ${note.expiresAt && html`<span class="note-badge">⏳ ${formatShort(parseDate(note.expiresAt))}</span>`}
          ${note.remindOn && html`<span class="note-badge">${note.repeatYearly ? '🎂' : '🔔'} ${formatShort(parseDate(note.remindOn))}${note.repeatYearly ? ' ↻' : ''}</span>`}
        </span>
        <button class="note-calendar ${(note.expiresAt || note.remindOn) ? 'active' : ''}"
          title="Expiry / reminder"
          onClick=${() => setDateEditorId(dateEditorId === note.id ? null : note.id)}>📅</button>
        <button class="note-pin ${note.pinned ? 'active' : ''}"
          title=${note.pinned ? 'Unpin' : 'Pin as key fact'}
          onClick=${() => togglePin(note)}>📌</button>
        <button class="note-delete" title="Delete note" onClick=${() => removeNote(note)}>×</button>
      </div>
      ${dateEditorId === note.id && html`
        <div class="note-date-editor">
          <label class="nde-field">
            <span>Expires</span>
            <input type="date" value=${note.expiresAt || ''}
              onChange=${(e) => saveNote(note, { expiresAt: e.target.value || null })} />
          </label>
          <label class="nde-field">
            <span>Remind</span>
            <input type="date" value=${note.remindOn || ''}
              onChange=${(e) => saveNote(note, { remindOn: e.target.value || null })} />
          </label>
          <label class="nde-yearly">
            <input type="checkbox" checked=${!!note.repeatYearly}
              disabled=${!note.remindOn}
              onChange=${(e) => saveNote(note, { repeatYearly: e.target.checked ? 1 : 0 })} />
            <span>yearly</span>
          </label>
        </div>
      `}
    </div>
  `;

  return html`
    <div class="person-detail">
      <div class="person-header">
        <div class="budget-title-row">
          ${editingName ? html`
            <input class="budget-title-input" type="text" ref=${nameRef}
              value=${person.name}
              onKeyDown=${(e) => { if (e.key === 'Enter') renamePerson(e.target.value); if (e.key === 'Escape') setEditingName(false); }}
              onBlur=${(e) => renamePerson(e.target.value)} />
          ` : html`
            <h2 class="budget-title" onClick=${() => { setEditingName(true); setTimeout(() => nameRef.current?.select(), 0); }}>
              ${person.name}
            </h2>
          `}
          <button class="budget-delete-btn" onClick=${() => setConfirmDelete(true)}>Delete</button>
        </div>
        ${editingTag ? html`
          <input class="person-tag-input" type="text" ref=${tagRef}
            value=${tags.join(', ')}
            placeholder="tags, comma separated — e.g. friend, gym"
            onKeyDown=${(e) => { if (e.key === 'Enter') retagPerson(e.target.value); if (e.key === 'Escape') setEditingTag(false); }}
            onBlur=${(e) => retagPerson(e.target.value)} />
        ` : html`
          <button class="person-tag-row"
            onClick=${() => { setEditingTag(true); setTimeout(() => tagRef.current?.select(), 0); }}>
            ${tags.length > 0
              ? tags.map(t => html`<span class="person-tag" key=${t}>${t}</span>`)
              : html`<span class="person-tag empty">+ add tags</span>`}
          </button>
        `}
      </div>

      ${confirmDelete && html`
        <div class="confirm-bar">
          <span>Delete ${person.name} and all their notes?</span>
          <button class="btn btn-danger" onClick=${deletePerson}>Yes, delete</button>
          <button class="btn btn-secondary" onClick=${() => setConfirmDelete(false)}>Cancel</button>
        </div>
      `}

      <div class="note-add">
        <input class="note-add-input" type="text" value=${newNote}
          placeholder="Add a note…"
          enterkeyhint="send"
          onInput=${(e) => setNewNote(e.target.value)}
          onKeyDown=${(e) => { if (e.key === 'Enter') addNote(); }} />
        <button class="btn" disabled=${!newNote.trim()} onClick=${addNote}>Add</button>
      </div>

      ${facts.length > 0 && html`
        <div class="facts-section">
          <h3 class="section-label">Key facts</h3>
          ${facts.map(n => noteRow(n, 'fact-row'))}
        </div>
      `}

      <div class="note-list">
        ${notes.length === 0 ? html`
          <div class="empty-state">No notes yet</div>
        ` : timeline.map(n => noteRow(n, 'note-row'))}
      </div>

      ${expired.length > 0 && html`
        <div class="expired-section">
          <button class="expired-toggle" onClick=${() => setShowExpired(!showExpired)}>
            ${showExpired ? '▾' : '▸'} Expired notes (${expired.length})
          </button>
          ${showExpired && expired.map(n => noteRow(n, 'note-row expired'))}
        </div>
      `}
    </div>
  `;
}
