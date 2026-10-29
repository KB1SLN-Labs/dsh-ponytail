/* Ponytail native DSH client (rc3). Plain JS + React.createElement, no JSX, no bundler.
   Loaded by the host module loader; `react` comes from the host. Exports for the host:
   { apply, SettingsCard, StatusBand, Dashboard, loadHistory }. */
window.__ModuleLoader__.load({ id: '@kb1slnlabs/dsh-ponytail', factory: (require) => {
const React = require('react');
const h = React.createElement;

/* ---------- constants (single source of truth) ---------- */

const MODES = ['lite', 'full', 'ultra', 'off'];
const PICKER_IDS = MODES.concat(['status', 'reset', 'help']);
const SKILLS = [
  { name: 'ponytail-review', label: 'ponytail-review', detail: 'Code review through the minimal-code lens.' },
  { name: 'ponytail-audit', label: 'ponytail-audit', detail: 'Ranked quality audit of the whole repo.' },
  { name: 'ponytail-debt', label: 'ponytail-debt', detail: 'List shortcut comments as a debt ledger.' },
  { name: 'ponytail-gain', label: 'ponytail-gain', detail: 'Upstream benchmark reference (not this session).' },
  { name: 'ponytail-help', label: 'ponytail-help', detail: 'Explain the modes and how to switch them.' },
];
const OWNED_FIELDS = ['defaultMode', 'disabledSkills', 'showBand', 'expandedBand'];
const SETTINGS_ORDER = 30;
const BAND_ORDER = 40;
const DASHBOARD_ID = 'ponytail-dashboard';
const HISTORY_CONCURRENCY = 4;
const STATE_POLL_MS = 5000;

const MODE_COPY = {
  inherit: 'Inherit — follow the profile default (upstream PONYTAIL_DEFAULT_MODE when no profile value is set).',
  lite: 'Lite — complete the explicit ask, and name the simpler alternative in one line.',
  full: 'Full — reuse what already exists; the minimal implementation that fully works.',
  ultra: 'Ultra — as Full, plus stricter justification for anything added.',
  off: 'Off — Ponytail instructions are not injected for this scope.',
};

/* ---------- small shared helpers ---------- */

function classNames() {
  const out = [];
  for (let i = 0; i < arguments.length; i += 1) {
    const value = arguments[i];
    if (typeof value === 'string' && value) out.push(value);
  }
  return out.join(' ');
}

function isValidState(value) {
  if (!value || typeof value !== 'object') return false;
  if (!MODES.includes(value.mode)) return false;
  if (value.defaultMode !== undefined && !MODES.concat(['inherit']).includes(value.defaultMode)) return false;
  if (value.source !== undefined && typeof value.source !== 'string') return false;
  if (value.showBand !== undefined && typeof value.showBand !== 'boolean') return false;
  if (value.expandedBand !== undefined && typeof value.expandedBand !== 'boolean') return false;
  if (value.disabledSkills !== undefined && !Array.isArray(value.disabledSkills)) return false;
  // Optional in older response versions, but our route always sends the field.
  if (value.lastTest !== undefined && value.lastTest !== null && !isValidLastTest(value.lastTest)) return false;
  return true;
}

// A last-test record is only trusted when it is exactly one of the two shapes the
// backend helper emits. No coercion, no parsing of anything else.
function isValidLastTest(value) {
  if (!value || typeof value !== 'object') return false;
  if (typeof value.runner !== 'string' || !value.runner) return false;
  if (value.status === 'interrupted') return value.exitCode === null;
  if (value.status === 'exit') {
    return typeof value.exitCode === 'number' && Number.isSafeInteger(value.exitCode) && value.exitCode >= 0;
  }
  return false;
}

// The band renders the record strictly from the typed state — never a claim that
// tests passed, and stdout is never scanned. An exit code is evidence for that one
// recorded command only.
function lastTestText(lastTest) {
  if (!isValidLastTest(lastTest)) return 'Not recorded this process';
  if (lastTest.status === 'exit') return `${lastTest.runner}: exit ${lastTest.exitCode}`;
  return `${lastTest.runner}: interrupted`;
}

// A stats object is usable only if every field is already a safe number. No
// coercion: a malformed value must render Unavailable, never a fabricated zero.
function isValidStats(value) {
  if (!value || typeof value !== 'object') return false;
  for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'usageReports', 'turns']) {
    const count = value[key];
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) return false;
  }
  if (typeof value.activeMs !== 'number' || !Number.isFinite(value.activeMs) || value.activeMs < 0) return false;
  const open = value.openTurnStart;
  if (open !== null && !(typeof open === 'number' && Number.isFinite(open) && open >= 0)) return false;
  return true;
}

function formatCount(value) {
  // Host figures are numbers; a non-number is not measured, so it stays Unavailable.
  return typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('en-US') : 'Unavailable';
}

function formatDuration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return 'Unavailable';
  const n = Math.round(ms);
  if (n < 1000) return `${n} ms`;
  const totalSeconds = Math.round(n / 1000);
  if (totalSeconds < 60) return `${totalSeconds} s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function normalizeTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return null;
}

function normalizeDateKey(value) {
  const ms = normalizeTimestamp(value);
  if (ms === null) return '';
  const date = new Date(ms);
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

function formatDayLabel(dateKey) {
  if (!dateKey) return 'No update date';
  const parsed = Date.parse(`${dateKey}T00:00:00`);
  if (Number.isNaN(parsed)) return dateKey;
  return new Date(parsed).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

function sessionTitle(row) {
  const value = row && (row.title || row.name || row.label);
  if (typeof value === 'string' && value.trim()) return value.trim();
  return '(untitled session)';
}

function sessionIdOf(row) {
  if (!row) return '';
  const value = row.sessionId || row.id;
  return typeof value === 'string' ? value : '';
}

function projectionValuesOf(row) {
  const values = row && row.projections && row.projections.values;
  return values && typeof values === 'object' ? values : null;
}

function parseProjectionResponse(result) {
  if (!result || result.ok !== true) return { status: 'error', message: resultError(result) };
  const value = result.value;
  if (value === null || value === undefined) return { status: 'no-projection' };
  if (typeof value.kind === 'string' && value.kind.indexOf('migration') >= 0) return { status: 'migration-required' };
  if (value.kind !== 'sequenced') return { status: 'unknown-kind', message: `Unexpected projection kind: ${String(value.kind)}` };
  const stats = value.values && value.values.ponytailStats;
  if (!stats || typeof stats !== 'object') return { status: 'no-stats' };
  return { status: 'ok', stats };
}

function resultError(result) {
  if (result && result.error) {
    if (typeof result.error.message === 'string' && result.error.message) return result.error.message;
    if (typeof result.error === 'string') return result.error;
  }
  return 'The request failed.';
}

function abortError() {
  const error = new Error('Aborted');
  error.name = 'AbortError';
  return error;
}

/* ---------- scoped CSS (host theme tokens, with preview fallbacks) ---------- */

const STYLE = [
  '.ponytail-panel{box-sizing:border-box;padding:24px;max-width:980px;font-size:14px;line-height:1.5;color:var(--dsw-alias-label-primary,#e8e8ea)}',
  '@media (max-width:480px){.ponytail-panel{padding:32px 16px}}',
  '.ponytail-h{margin:0;font-size:18px;font-weight:600;letter-spacing:.01em}',
  '.ponytail-sub{margin:6px 0 0;font-size:14px;color:var(--dsw-alias-label-secondary,#a5a5ad);max-width:70ch}',
  '.ponytail-note{margin:12px 0 0;font-size:13px;color:var(--dsw-alias-label-secondary,#a5a5ad);max-width:70ch}',
  '.ponytail-sectitle{margin:28px 0 0;font-size:14px;font-weight:600}',
  '.ponytail-fieldset{border:0;margin:20px 0 0;padding:0}',
  '.ponytail-legend{font-size:14px;font-weight:600;padding:0}',
  '.ponytail-row{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin:12px 0}',
  '.ponytail-label{font-size:14px}',
  '.ponytail-select,.ponytail-button,.ponytail-input{font:inherit;color:inherit;background:var(--dsw-alias-bg-layer-2,#1f1f24);border:1px solid var(--dsw-alias-border-l4,#3a3a42);border-radius:8px;padding:8px 12px}',
  '.ponytail-select{min-width:160px;max-width:100%}',
  '.ponytail-button{cursor:pointer;background:var(--dsw-alias-bg-layer-3,#26262c)}',
  // Native hover token, with a transparent fallback if the host does not define it.
  '.ponytail-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,130,135,.14))}',
  '.ponytail-button:disabled{opacity:.5;cursor:not-allowed}',
  '.ponytail-check{display:flex;flex-wrap:wrap;align-items:flex-start;gap:10px;margin:10px 0}',
  '.ponytail-check input{margin-top:3px;accent-color:var(--dsw-alias-brand-primary,#4c8dff)}',
  '.ponytail-hint{margin:6px 0 0;font-size:13px;color:var(--dsw-alias-label-secondary,#a5a5ad);max-width:70ch}',
  '.ponytail-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:20px}',
  '.ponytail-status,.ponytail-alert{margin:14px 0 0;font-size:13px;max-width:70ch}',
  // Error text keeps the host primary foreground (inherited) — role="alert" plus the
  // "Error: " prefix carry the semantics, so no semantic error token or new colour.
  '.ponytail-alert{color:inherit;font-weight:500}',
  '.ponytail-details{margin-top:20px}',
  '.ponytail-details summary{cursor:pointer;font-size:14px}',
  '.ponytail-details p,.ponytail-details li{font-size:13px;line-height:1.6;color:var(--dsw-alias-label-secondary,#a5a5ad)}',
  '.ponytail-modehelp{margin:0 0 0;padding-left:18px}',
  '.ponytail-panel :focus-visible,.ponytail-band-wrap :focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4c8dff);outline-offset:2px}',
  /* status band */
  '.ponytail-band-wrap{color:var(--dsw-alias-label-primary,#e8e8ea)}',
  '.ponytail-band{display:flex;flex-wrap:wrap;align-items:center;gap:10px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l4,#3a3a42);border-radius:10px;background:var(--dsw-alias-bg-layer-3,#26262c);color:var(--dsw-alias-label-primary,#e8e8ea);font-size:14px}',
  '.ponytail-band-label{font-weight:600}',
  '.ponytail-band-item{display:flex;flex-wrap:wrap;align-items:center;gap:6px;color:var(--dsw-alias-label-secondary,#a5a5ad)}',
  '.ponytail-band-value{color:var(--dsw-alias-label-primary,#e8e8ea)}',
  '.ponytail-band-details{display:grid;gap:10px;margin-top:10px;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l4,#3a3a42)}',
  // Inside the grid, the stacked-flow margins are handled by the gap.
  '.ponytail-band-details .ponytail-actions,.ponytail-band-details .ponytail-hint{margin-top:0}',
  '.ponytail-band-metrics{display:flex;flex-wrap:wrap;gap:8px 18px}',
  '.ponytail-band-error{margin:8px 0 0;font-size:13px;color:inherit;font-weight:500}',
  /* dashboard */
  '.ponytail-filtergrid{display:flex;flex-wrap:wrap;gap:14px;margin-top:20px}',
  '.ponytail-filter{display:flex;flex-direction:column;gap:6px;min-width:200px;max-width:100%}',
  '.ponytail-tablewrap{overflow-x:auto;margin-top:18px;border:1px solid var(--dsw-alias-border-l4,#3a3a42);border-radius:10px;background:var(--dsw-alias-bg-layer-3,#26262c)}',
  '.ponytail-table{width:100%;min-width:760px;border-collapse:collapse;font-size:14px}',
  '.ponytail-table th,.ponytail-table td{text-align:left;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l4,#3a3a42);white-space:nowrap}',
  '.ponytail-table th{font-weight:600;color:var(--dsw-alias-label-secondary,#a5a5ad)}',
  '.ponytail-id{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}',
  '.ponytail-summary{display:flex;flex-wrap:wrap;gap:8px 22px;margin-top:16px;font-size:14px}',
  '.ponytail-muted{color:var(--dsw-alias-label-secondary,#a5a5ad)}',
].join('');

/* ---------- locale (English copy only) ---------- */

const EN = {
  title: 'Ponytail',
  settingsIntro: 'Profile defaults for Ponytail, the minimal-code ruleset and its review skills.',
  boundary: 'These are profile defaults. A per-session override set with /ponytail lite|full|ultra|off wins for that session until it is reset or the process restarts. When no profile value is set, the upstream PONYTAIL_DEFAULT_MODE environment variable applies.',
  defaultMode: 'Default mode',
  skillsTitle: 'Optional skills',
  skillsHint: 'Checking a box here only controls whether that skill and its one-shot command are registered. It does not run the skill.',
  showBand: 'Show the status band in the conversation composer',
  expandedBand: 'Start the status band expanded',
  save: 'Save profile defaults',
  saving: 'Saving…',
  reset: 'Reset panel defaults',
  discard: 'Discard edits',
  discardHint: 'Reloads current profile values without saving.',
  resetHint: 'Reset clears only Ponytail’s four own profile fields (default mode, disabled skills, band visibility and expansion). Session overrides are untouched.',
  help: 'How these settings interact',
  helpBody: 'A per-session override from /ponytail outranks everything below. Next, the profile default you set here applies. If no profile value is set, the upstream PONYTAIL_DEFAULT_MODE environment variable is used. Resetting here clears the profile values so that chain applies again.',
  refused: 'The host refused this write (it may be read-only elsewhere).',
  saved: 'Profile defaults saved.',
  resetDone: 'Profile defaults reset.',
  readOnly: 'This profile is read-only, so settings cannot be saved here.',
  notReady: 'Settings are not available yet.',
  skillsEnabled: 'Enabled',
  skillsDisabled: 'Disabled in profile',
};

function makeT(locale) {
  if (locale && typeof locale.bind === 'function') {
    const bound = locale.bind('ponytail');
    if (typeof bound === 'function') return (key) => bound(key) || EN[key] || key;
  }
  return (key) => EN[key] || key;
}

/* ---------- SettingsCard ---------- */

function useScopeSnapshot(scope) {
  const getSnapshot = React.useCallback(() => scope.getSnapshot(), [scope]);
  const subscribe = React.useCallback((listener) => scope.subscribe(listener), [scope]);
  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

function SettingsCard({ scope }) {
  const snapshot = useScopeSnapshot(scope);
  const value = (snapshot && snapshot.value) || {};
  const writable = !!(snapshot && snapshot.writable);
  const ready = !!snapshot && snapshot.status === 'ready';

  const [draft, setDraft] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState('');
  const [failed, setFailed] = React.useState(false);
  // Write guard: a second click while a mutate is in flight must not start another.
  const busyRef = React.useRef(false);

  const disabledSkills = Array.isArray(value.disabledSkills) ? value.disabledSkills : [];
  const current = {
    defaultMode: MODES.concat(['inherit']).includes(value.defaultMode) ? value.defaultMode : 'inherit',
    enabledSkills: SKILLS.filter((skill) => !disabledSkills.includes(skill.name)).map((skill) => skill.name),
    showBand: value.showBand !== false,
    expandedBand: value.expandedBand === true,
  };
  const form = draft || current;

  const dirty = !!draft
    && (draft.defaultMode !== current.defaultMode
      || draft.showBand !== current.showBand
      || draft.expandedBand !== current.expandedBand
      || draft.enabledSkills.length !== current.enabledSkills.length
      || SKILLS.some((skill) => draft.enabledSkills.includes(skill.name) !== current.enabledSkills.includes(skill.name)));

  const disabled = busy || !writable || !ready;

  function patch(next) {
    // The draft keeps the revision it was opened at, so a later save cannot silently
    // write over a newer snapshot.
    setDraft(Object.assign({}, form, next, { _revision: draft ? draft._revision : snapshot.revision }));
    setMessage('');
    setFailed(false);
  }

  function discardDraft() {
    // State change only: the unsaved draft and its stale revision are dropped so the
    // panel falls back to the current snapshot. Nothing is written to the host.
    if (!draft || busy) return;
    setDraft(null);
    setMessage('');
    setFailed(false);
  }

  async function commit(isReset) {
    if (disabled || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setMessage('');
    setFailed(false);
    const ops = isReset
      ? OWNED_FIELDS.map((path) => ({ op: 'unset', path: [path] }))
      : [
          { op: 'set', path: ['defaultMode'], value: form.defaultMode },
          {
            op: 'set',
            path: ['disabledSkills'],
            value: SKILLS.filter((skill) => !form.enabledSkills.includes(skill.name)).map((skill) => skill.name),
          },
          { op: 'set', path: ['showBand'], value: form.showBand },
          { op: 'set', path: ['expandedBand'], value: form.expandedBand },
        ];
    try {
      // A reset has no typed input to protect, so it writes against the newest
      // snapshot; a save keeps the revision the draft was built against and a
      // stale write is refused, not silently merged.
      const result = await scope.mutate(ops, isReset ? snapshot.revision : form._revision);
      if (result === false) throw new Error('refused');
      setDraft(null);
      setMessage(isReset ? EN.resetDone : EN.saved);
    } catch (error) {
      // Draft preserved exactly as typed so nothing the operator entered is lost.
      setFailed(true);
      setMessage(error && error.message === 'refused' ? EN.refused : `${EN.refused} ${error && error.message ? error.message : ''}`.trim());
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return h('section', { className: 'ponytail-panel ponytail-settings' },
    h('h2', { className: 'ponytail-h' }, EN.title),
    h('p', { className: 'ponytail-sub' }, EN.settingsIntro),
    h('p', { className: 'ponytail-note' }, EN.boundary),
    !ready ? h('p', { className: 'ponytail-status', role: 'status' }, EN.notReady) : null,
    ready && !writable ? h('p', { className: 'ponytail-status', role: 'status' }, EN.readOnly) : null,

    h('div', { className: 'ponytail-row' },
      h('label', { className: 'ponytail-label', htmlFor: 'ponytail-default-mode' }, EN.defaultMode),
      h('select', {
        id: 'ponytail-default-mode',
        className: 'ponytail-select',
        value: form.defaultMode,
        disabled,
        'aria-describedby': 'ponytail-default-mode-help',
        onChange: (event) => patch({ defaultMode: event.target.value }),
      }, MODES.concat(['inherit']).map((mode) => h('option', { key: mode, value: mode }, mode))),
    ),
    h('p', { className: 'ponytail-hint', id: 'ponytail-default-mode-help' }, MODE_COPY[form.defaultMode]),

    h('fieldset', { className: 'ponytail-fieldset' },
      h('legend', { className: 'ponytail-legend' }, EN.skillsTitle),
      SKILLS.map((skill) => {
        const checked = form.enabledSkills.includes(skill.name);
        return h('label', { key: skill.name, className: 'ponytail-check' },
          h('input', {
            type: 'checkbox',
            checked,
            disabled,
            onChange: () => patch({
              enabledSkills: checked
                ? form.enabledSkills.filter((name) => name !== skill.name)
                : form.enabledSkills.concat([skill.name]),
            }),
          }),
          h('span', null,
            h('span', null, skill.label),
            h('span', { className: 'ponytail-muted', style: { display: 'block' } }, skill.detail),
          ),
        );
      }),
      h('p', { className: 'ponytail-hint' }, EN.skillsHint),
    ),

    h('fieldset', { className: 'ponytail-fieldset' },
      h('legend', { className: 'ponytail-legend' }, 'Status band'),
      h('label', { className: 'ponytail-check' },
        h('input', { type: 'checkbox', checked: form.showBand, disabled, onChange: () => patch({ showBand: !form.showBand }) }),
        h('span', null, EN.showBand),
      ),
      h('label', { className: 'ponytail-check' },
        h('input', { type: 'checkbox', checked: form.expandedBand, disabled, onChange: () => patch({ expandedBand: !form.expandedBand }) }),
        h('span', null, EN.expandedBand),
      ),
    ),

    h('div', { className: 'ponytail-actions' },
      h('button', { type: 'button', className: 'ponytail-button', disabled: disabled || !dirty, onClick: () => void commit(false) }, busy ? EN.saving : EN.save),
      h('button', { type: 'button', className: 'ponytail-button', disabled, 'aria-describedby': 'ponytail-reset-hint', onClick: () => void commit(true) }, EN.reset),
      h('button', { type: 'button', className: 'ponytail-button', disabled: !draft || busy, 'aria-describedby': 'ponytail-discard-hint', onClick: discardDraft }, EN.discard),
    ),
    h('p', { className: 'ponytail-hint', id: 'ponytail-reset-hint' }, EN.resetHint),
    h('p', { className: 'ponytail-hint', id: 'ponytail-discard-hint' }, EN.discardHint),
    message ? h('p', { role: failed ? 'alert' : 'status', className: failed ? 'ponytail-alert' : 'ponytail-status' }, `${failed && message.indexOf('Error:') !== 0 ? 'Error: ' : ''}${message}`) : null,

    h('details', { className: 'ponytail-details' },
      h('summary', null, EN.help),
      h('p', null, EN.helpBody),
      h('ul', { className: 'ponytail-modehelp' }, MODES.concat(['inherit']).map((mode) => h('li', { key: mode }, MODE_COPY[mode]))),
    ),
  );
}

/* ---------- typed state (read-only backend view) ---------- */

function usePonytailState(connection, sessionId) {
  const [state, setState] = React.useState(null);
  const [error, setError] = React.useState('');

  const refresh = React.useCallback(async (signal) => {
    if (!connection || !sessionId) return;
    const controller = signal ? null : new AbortController();
    const activeSignal = signal || controller.signal;
    try {
      const result = await connection.rpc.call('/api', 'ponytail/state', { sessionId }, activeSignal);
      // A response that arrived after its signal was aborted belongs to a superseded
      // binding — it must never replace the current session's state.
      if (activeSignal.aborted) return;
      if (result && result.ok === true && isValidState(result.value)) {
        // Defaults are applied only from a valid response; an error never implies "full".
        setState(result.value);
        setError('');
      } else if (result && result.ok === true) {
        setError('The state response was not recognised.');
      } else {
        setError(resultError(result));
      }
    } catch (caught) {
      if (caught && caught.name === 'AbortError') return;
      setError(caught && caught.message ? caught.message : 'Could not read Ponytail state.');
    }
  }, [connection, sessionId]);

  const requestRef = React.useRef(refresh);
  requestRef.current = refresh;

  React.useEffect(() => {
    // New binding (session or connection): drop the previous session's state and error
    // so an old value is never shown as if it were current.
    setState(null);
    setError('');
    let mounted = true;
    const inFlight = new Map();

    const run = () => {
      if (!mounted) return;
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      if (inFlight.size > 0) return; // no overlapping requests
      const controller = new AbortController();
      inFlight.set(sessionId, controller);
      Promise.resolve()
        .then(() => requestRef.current(controller.signal))
        .catch(() => {})
        .then(() => { inFlight.delete(sessionId); });
    };

    run();
    const onStateChange = (event) => {
      if (!event || !event.detail || event.detail === sessionId) run();
    };
    window.addEventListener('ponytail-state-change', onStateChange);
    const timer = setInterval(run, STATE_POLL_MS);
    return () => {
      mounted = false;
      clearInterval(timer);
      window.removeEventListener('ponytail-state-change', onStateChange);
      for (const controller of inFlight.values()) controller.abort();
    };
  }, [sessionId, connection]);

  return { state, error, refresh };
}

function useScopePrefs(scope) {
  const getSnapshot = React.useCallback(() => scope.getSnapshot(), [scope]);
  const subscribe = React.useCallback((listener) => scope.subscribe(listener), [scope]);
  const snapshot = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return {
    snapshot,
    prefs: {
      showBand: !snapshot || !snapshot.value ? null : snapshot.value.showBand !== false,
      expandedBand: !snapshot || !snapshot.value ? null : snapshot.value.expandedBand === true,
    },
  };
}

function mutatePrefs(scope, field, value) {
  const snapshot = scope.getSnapshot();
  return Promise.resolve()
    .then(() => scope.mutate([{ op: 'set', path: [field], value }], snapshot.revision))
    .then((result) => {
      if (result === false) throw new Error('The host refused this write.');
      return result;
    });
}

/* ---------- StatusBand ---------- */

function StatusBand({ sessionId, connection, remote, layout, scope, useProjection }) {
  const stats = useProjection('ponytailStats'); // host-provided hook; always called
  const { state, error } = usePonytailState(connection, sessionId);
  const { prefs, snapshot: prefsSnapshot } = useScopePrefs(scope);

  const showBand = typeof prefs.showBand === 'boolean' ? prefs.showBand : (state && typeof state.showBand === 'boolean' ? state.showBand : true);
  // Expanded comes straight from the accepted profile value (falling back to the
  // session state) — no separate local copy, so a refused write cannot leave the band
  // showing something the host never accepted.
  const expanded = typeof prefs.expandedBand === 'boolean' ? prefs.expandedBand : (state && typeof state.expandedBand === 'boolean' ? state.expandedBand : false);
  const [prefError, setPrefError] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  // Write guard for band preference mutates: rapid clicks must not overlap.
  const prefBusyRef = React.useRef(false);
  const [notice, setNotice] = React.useState('');

  if (!showBand) return null;

  const mode = state && MODES.includes(state.mode) ? state.mode : '';
  // Review/Audit queue model work — keep them unavailable until the typed state (and
  // with it the disabled-skill list) is actually known.
  const skillsKnown = !!state && Array.isArray(state.disabledSkills);
  const disabledSkills = skillsKnown ? state.disabledSkills : [];
  const hasStats = isValidStats(stats);
  // Tokens and cache are only "measured" when at least one usage report exists; a
  // genuine zero with usageReports >= 1 is valid, usageReports 0 is not measured data.
  const hasUsage = hasStats && stats.usageReports > 0;
  const totalTokens = hasUsage ? stats.inputTokens + stats.outputTokens : null;

  async function changeMode(event) {
    const next = event.target.value;
    if (!MODES.includes(next) || !remote || !remote.commands || !sessionId) return;
    // Clear the previous action error as soon as a retry starts.
    setPrefError('');
    setBusy(true);
    setNotice('');
    try {
      const result = await remote.commands.execute(sessionId, `/ponytail ${next}`, []);
      if (!result || !result.ok) throw new Error(resultError(result));
      window.dispatchEvent(new CustomEvent('ponytail-state-change', { detail: sessionId }));
    } catch (caught) {
      setPrefError(caught && caught.message ? caught.message : 'Could not change the mode.');
    } finally {
      setBusy(false);
    }
  }

  function savePref(field, value, failureMessage) {
    if (prefBusyRef.current) return;
    prefBusyRef.current = true;
    setBusy(true);
    setPrefError('');
    mutatePrefs(scope, field, value).catch((caught) => {
      // The band keeps its previous appearance: expanded/showBand are read back from
      // the host snapshot, so a refusal simply leaves them unchanged.
      setPrefError(caught && caught.message ? caught.message : failureMessage);
    }).finally(() => {
      prefBusyRef.current = false;
      setBusy(false);
    });
  }

  function toggleExpanded() {
    savePref('expandedBand', !expanded, 'Could not save the band preference.');
  }

  function hideBand() {
    savePref('showBand', false, 'Could not hide the band. Re-enable it in Settings → Ponytail.');
  }

  async function runSkill(command) {
    if (!remote || !remote.commands || !sessionId) return;
    setPrefError('');
    setBusy(true);
    setNotice('');
    try {
      const result = await remote.commands.execute(sessionId, command, []);
      if (!result || !result.ok) throw new Error(resultError(result));
    } catch (caught) {
      setPrefError(caught && caught.message ? caught.message : `Could not start ${command}.`);
    } finally {
      setBusy(false);
    }
  }

  function copySummary() {
    const lines = [
      'Ponytail',
      `Mode: ${mode || 'Unavailable'}`,
      state && state.source ? `Source: ${state.source}` : '',
      state && state.defaultMode ? `Profile default: ${state.defaultMode}` : '',
      `Tokens: input ${formatCount(hasUsage ? stats.inputTokens : null)}, output ${formatCount(hasUsage ? stats.outputTokens : null)}`,
      `Cache read ${formatCount(hasUsage ? stats.cacheReadTokens : null)}, cache write ${formatCount(hasUsage ? stats.cacheWriteTokens : null)}`,
      `Turns: ${formatCount(hasStats ? stats.turns : null)}`,
      `Active time: ${formatDuration(hasStats ? stats.activeMs : null)}`,
      `Last test command: ${lastTestText(state && state.lastTest)}`,
    ].filter(Boolean);
    const text = lines.join('\n');
    if (!navigator.clipboard || !navigator.clipboard.writeText) {
      setPrefError('Clipboard is unavailable in this environment, so the summary was not copied.');
      return;
    }
    navigator.clipboard.writeText(text).then(
      () => setNotice('Summary copied.'),
      (caught) => setPrefError(`Copy failed: ${caught && caught.message ? caught.message : 'clipboard unavailable'}`),
    );
  }

  const skillDisabled = busy || !remote || !sessionId;
  const prefsDisabled = busy || !prefsSnapshot || !prefsSnapshot.writable || prefsSnapshot.status !== 'ready';

  return h('div', { className: 'ponytail-band-wrap' },
    h('div', { className: 'ponytail-band' },
      h('span', { className: 'ponytail-band-label' }, 'Ponytail'),
      h('span', { className: 'ponytail-band-item' },
        h('label', { htmlFor: 'ponytail-band-mode' }, 'Mode'),
        h('select', {
          id: 'ponytail-band-mode',
          className: 'ponytail-select',
          value: mode,
          disabled: skillDisabled,
          onChange: (event) => void changeMode(event),
        }, h('option', { value: '' }, state ? 'Unavailable' : 'Loading…'),
          MODES.map((value) => h('option', { key: value, value: value }, value))),
      ),
      h('span', { className: 'ponytail-band-item' }, 'Tokens ',
        h('span', { className: 'ponytail-band-value' }, totalTokens === null ? 'Usage unavailable' : formatCount(totalTokens))),
      h('span', { className: 'ponytail-band-item' }, 'Active ',
        h('span', { className: 'ponytail-band-value' }, formatDuration(hasStats ? stats.activeMs : null))),
      h('button', { type: 'button', className: 'ponytail-button', disabled: prefsDisabled, onClick: toggleExpanded, 'aria-expanded': expanded ? 'true' : 'false' }, expanded ? 'Collapse' : 'Expand'),
      h('button', { type: 'button', className: 'ponytail-button', disabled: !layout || typeof layout.selectPanel !== 'function', onClick: () => layout.selectPanel(DASHBOARD_ID) }, 'Dashboard'),
      h('button', { type: 'button', className: 'ponytail-button', disabled: prefsDisabled, onClick: hideBand }, 'Hide'),
    ),
    error ? h('p', { className: 'ponytail-band-error', role: 'alert' }, `Error: ${error} Known values are kept.`) : null,
    prefError ? h('p', { className: 'ponytail-band-error', role: 'alert' }, `Error: ${prefError}`) : null,
    notice ? h('p', { className: 'ponytail-status', role: 'status' }, notice) : null,
    expanded ? h('div', { className: 'ponytail-band-details' },
      h('div', { className: 'ponytail-band-metrics' },
        h('span', { className: 'ponytail-band-item' }, 'Input ', h('span', { className: 'ponytail-band-value' }, formatCount(hasUsage ? stats.inputTokens : null))),
        h('span', { className: 'ponytail-band-item' }, 'Output ', h('span', { className: 'ponytail-band-value' }, formatCount(hasUsage ? stats.outputTokens : null))),
        h('span', { className: 'ponytail-band-item' }, 'Cache read ', h('span', { className: 'ponytail-band-value' }, formatCount(hasUsage ? stats.cacheReadTokens : null))),
        h('span', { className: 'ponytail-band-item' }, 'Cache write ', h('span', { className: 'ponytail-band-value' }, formatCount(hasUsage ? stats.cacheWriteTokens : null))),
        h('span', { className: 'ponytail-band-item' }, 'Turns ', h('span', { className: 'ponytail-band-value' }, formatCount(hasStats ? stats.turns : null))),
        h('span', { className: 'ponytail-band-item' }, 'Last test command ', h('span', { className: 'ponytail-band-value' }, lastTestText(state && state.lastTest))),
      ),
      h('p', { className: 'ponytail-hint' }, 'A recorded command exit is evidence for that command only.'),
      state ? h('div', { className: 'ponytail-band-metrics' },
        h('span', { className: 'ponytail-band-item' }, 'Source ', h('span', { className: 'ponytail-band-value' }, state.source || 'Unavailable')),
        h('span', { className: 'ponytail-band-item' }, 'Profile default ', h('span', { className: 'ponytail-band-value' }, state.defaultMode || 'Unavailable')),
      ) : null,
      h('div', { className: 'ponytail-actions' },
        h('button', { type: 'button', className: 'ponytail-button', onClick: copySummary }, 'Copy summary'),
        h('button', {
          type: 'button', className: 'ponytail-button', disabled: skillDisabled || !skillsKnown || disabledSkills.includes('ponytail-review'),
          'aria-describedby': 'ponytail-skill-hint', onClick: () => void runSkill('/ponytail-review'),
        }, 'Review'),
        h('button', {
          type: 'button', className: 'ponytail-button', disabled: skillDisabled || !skillsKnown || disabledSkills.includes('ponytail-audit'),
          'aria-describedby': 'ponytail-skill-hint', onClick: () => void runSkill('/ponytail-audit'),
        }, 'Audit'),
      ),
      h('p', { className: 'ponytail-hint', id: 'ponytail-skill-hint' }, 'Review and Audit start model work. They stay disabled until the session state is known, and when the matching skill is disabled in profile settings.'),
    ) : null,
  );
}

/* ---------- history loading (exported, testable) ---------- */

// A filter cutoff is either a finite epoch-ms number or null (= All). Anything else
// falls back to null — a malformed filter never silently narrows or widens the read.
function normalizeUpdatedSince(value) {
  if (value === undefined || value === null) return null;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

// The project key shared by metadata rows and the dropdown: project, else cwd.
function projectKeyOf(row) {
  return row.project || row.cwd || '';
}

async function loadHistory(remote, signal, options) {
  if (!remote || !remote.session || typeof remote.session.list !== 'function') {
    throw new Error('loadHistory needs remote.session.list');
  }
  const opts = options || {};
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
  // updatedSince / project bound WHICH sessions get a projection read. Defaults keep
  // the old behaviour exactly: null = All dates, 'all' = every project.
  const updatedSince = normalizeUpdatedSince(opts.updatedSince);
  const selectedProject = typeof opts.project === 'string' ? opts.project : 'all';

  const listResult = await remote.session.list({}, signal);
  if (!listResult || listResult.ok !== true) throw new Error(resultError(listResult));
  // A successful list whose items are missing or not an array is a broken contract —
  // it must fail readably, never masquerade as an empty history.
  if (!listResult.value || typeof listResult.value !== 'object' || !Array.isArray(listResult.value.items)) {
    throw new Error('The session list response was not recognised: expected a value with an items array.');
  }
  const items = listResult.value.items;

  // Cached projections ride on the list items; keep them so a warm cache is not
  // thrown away and re-fetched. A null or non-object item normalizes to {} at the
  // mapping start — it becomes an no-session-id row below, never a property read crash.
  const allRows = items.map((raw) => {
    const item = raw && typeof raw === 'object' ? raw : {};
    return {
    sessionId: sessionIdOf(item),
    title: sessionTitle(item),
    cwd: typeof item.cwd === 'string' ? item.cwd : '',
    project: typeof item.project === 'string' ? item.project : '',
    updatedAtMs: normalizeTimestamp(item.updatedAt !== undefined ? item.updatedAt : item.updated_at),
    dateKey: normalizeDateKey(item.updatedAt !== undefined ? item.updatedAt : item.updated_at),
    projections: projectionValuesOf(item),
    stats: null,
    status: 'pending',
    statusMessage: '',
    };
  });

  // The catalog is the whole profile: every metadata row and every project it names.
  // It is computed from metadata only — cheap — so the filter dropdowns stay stable
  // while a narrower selection is being read.
  const catalogTotal = allRows.length;
  const projects = [];
  const seenProjects = new Set();
  for (const row of allRows) {
    const key = projectKeyOf(row);
    if (key && !seenProjects.has(key)) {
      seenProjects.add(key);
      projects.push(key);
    }
  }

  // Filtering happens on metadata, BEFORE any remote.session.projections request: an
  // out-of-window or undated row, and a row from another project, is never read cold.
  // An undated row is excluded by any date window and included when updatedSince is null.
  const rows = allRows.filter((row) => {
    if (updatedSince !== null && !(row.updatedAtMs !== null && row.updatedAtMs >= updatedSince)) return false;
    if (selectedProject !== 'all' && projectKeyOf(row) !== selectedProject) return false;
    return true;
  });

  const pending = [];
  // failed counts rows this client cannot report usage for — an unresolved identity
  // or a cold read that did not land usable usage. Cached successes are `available`,
  // never failures, so this is never derived from "everything not still pending".
  let failed = 0;
  for (const row of rows) {
    if (!row.sessionId) {
      // An unresolved row with no id is a failure, never counted as available.
      row.status = 'no-session-id';
      failed += 1;
      continue;
    }
    const cached = row.projections;
    if (cached && isValidStats(cached.ponytailStats)) {
      if (cached.ponytailStats.usageReports > 0) {
        // A valid cached report with at least one usage record needs no cold read.
        row.stats = cached.ponytailStats;
        row.status = 'available';
      } else {
        row.status = 'no-usage';
        failed += 1;
      }
      continue;
    }
    pending.push(row);
  }
  const report = () => {
    if (onProgress && !(signal && signal.aborted)) {
      // total is the SELECTED count — only selected rows enter the cache/cold pipeline.
      onProgress({ total: rows.length, available: rows.filter((row) => row.status === 'available').length, failed, catalogTotal, projectCount: projects.length });
    }
  };
  report();

  let cursor = 0;
  const workers = [];
  for (let w = 0; w < HISTORY_CONCURRENCY; w += 1) {
    workers.push((async () => {
      while (cursor < pending.length) {
        if (signal && signal.aborted) return;
        const row = pending[cursor];
        cursor += 1;
        try {
          const parsed = parseProjectionResponse(await remote.session.projections({ sessionId: row.sessionId }, signal));
          if (parsed.status === 'ok' && isValidStats(parsed.stats)) {
            if (parsed.stats.usageReports > 0) {
              // Usage the provider actually reported — including a genuine zero-token
              // report, which is measured data (usageReports >= 1).
              row.stats = parsed.stats;
              row.status = 'available';
            } else {
              // A valid stats shape with zero usage reports was never measured: it is
              // explicitly unavailable, never an invented measured zero.
              row.status = 'no-usage';
              failed += 1;
            }
          } else if (parsed.status === 'ok') {
            // A projection that answers with stats this client cannot trust stays
            // explicitly unavailable — no invented zero.
            row.status = 'no-stats';
            row.statusMessage = '';
            failed += 1;
          } else {
            row.status = parsed.status;
            row.statusMessage = parsed.message || '';
            failed += 1;
          }
        } catch (caught) {
          if (caught && caught.name === 'AbortError') return;
          row.status = 'error';
          row.statusMessage = caught && caught.message ? caught.message : 'Could not load usage for this session.';
          failed += 1;
        }
        report();
      }
    })());
  }
  await Promise.all(workers);

  // An abort is an abort: a partial walk is never reported as success.
  if (signal && signal.aborted) throw abortError();

  const available = rows.filter((row) => row.status === 'available').length;
  // available is always the actual status count, never total-minus-failures.
  // total is the selected (filtered) count; catalogTotal/projects describe the whole
  // profile metadata and are what the filter controls offer across any selection.
  return { rows, total: rows.length, available, failed, catalogTotal, projects };
}

/* ---------- Dashboard ---------- */

const RANGE_OPTIONS = [
  { id: '7d', label: 'Last 7 days' },
  { id: '30d', label: 'Last 30 days' },
  { id: 'all', label: 'All' },
];

// Product copy for a history row's usage state — the internal status codes are never
// shown to the operator as-is.
function usageStatusLabel(row) {
  if (row.status === 'available') return 'Available';
  if (!row.sessionId) return 'Missing session identity';
  switch (row.status) {
    case 'no-usage':
      return 'No recorded usage';
    case 'no-projection':
    case 'no-stats':
      return 'Usage unavailable';
    case 'migration-required':
      return 'Needs DSH migration';
    case 'error':
      return row.statusMessage ? `Read failed: ${row.statusMessage}` : 'Read failed';
    default:
      // unknown-kind and anything unexpected still reads as a sentence, not a code.
      return row.statusMessage ? `Usage unavailable: ${row.statusMessage}` : 'Usage unavailable';
  }
}

function aggregate(rows) {
  const totals = { inputTokens: 0, outputTokens: 0, activeMs: 0, turns: 0 };
  let counted = 0;
  for (const row of rows) {
    if (!isValidStats(row.stats)) continue;
    counted += 1;
    totals.inputTokens += row.stats.inputTokens;
    totals.outputTokens += row.stats.outputTokens;
    totals.activeMs += row.stats.activeMs;
    totals.turns += row.stats.turns;
  }
  return { totals, counted };
}

function usageTable(caption, headers, rows) {
  const heading = h('tr', null, headers.map((name, i) => h('th', {key:i, scope:'col'}, name)));
  const body = rows.length ? rows.map((cells, i) => h('tr', {key:i}, cells.map((cell, j) => h('td', {key:j}, cell))))
    : h('tr', null, h('td', {colSpan:headers.length}, 'No sessions in this selection.'));
  const table = h('table', {className:'ponytail-table'}, h('caption', null, caption), h('thead', null, heading), h('tbody', null, body));
  return h('div', {className:'ponytail-tablewrap', tabIndex:0, role:'region', 'aria-label':caption}, table);
}

// Range id → window length in ms (null = All, which also admits undated rows).
function rangeWindowMs(range) {
  if (range === '7d') return 7 * 86400000;
  if (range === '30d') return 30 * 86400000;
  return null;
}

function Dashboard({ remote, openSession }) {
  const [history, setHistory] = React.useState(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState('');
  const [progress, setProgress] = React.useState(null);
  const [range, setRange] = React.useState('30d');
  const [project, setProject] = React.useState('all');
  const [refreshNonce, setRefreshNonce] = React.useState(0);
  // The project catalog is kept across filter changes and while a narrower read runs,
  // so the dropdown never loses an option just because the current selection omits it.
  const [catalogProjects, setCatalogProjects] = React.useState([]);
  // Every started read is tracked: only the newest may write state, and each effect
  // cleanup aborts its own in-flight controller.
  const requestSeqRef = React.useRef(0);
  async function runRead(request) {
    const controller = new AbortController();
    request.controller = controller;
    setLoading(true); setError(''); setProgress(null);
    // Only the current request may write history/progress/error/loading. A slow aborted
    // read can neither overwrite the newer results nor clear the newer loading flag.
    const current = () => request.active && request.seq === requestSeqRef.current && !controller.signal.aborted;
    try {
      const windowMs = rangeWindowMs(request.range);
      const result = await loadHistory(remote, controller.signal, {
        updatedSince: windowMs === null ? null : Date.now() - windowMs,
        project: request.project,
        onProgress: (p) => { if (current()) setProgress(p); },
      });
      if (current()) {
        setHistory(result);
        setCatalogProjects(result.projects);
      }
    } catch (caught) {
      if (current()) setError(caught.message || 'Could not load history. Try Refresh again.');
    } finally {
      if (current()) { request.active = false; setLoading(false); }
    }
  }
  React.useEffect(() => {
    requestSeqRef.current += 1;
    const request = { active: true, seq: requestSeqRef.current, range, project, controller: null };
    void runRead(request);
    // A filter change or unmount aborts the previous read before the new one starts.
    return () => { request.active = false; if (request.controller) request.controller.abort(); };
  }, [remote, range, project, refreshNonce]);
  // Rows are exactly what the selected filter read back — no post-load filtering.
  const rows = history ? history.rows : [];
  const summary = aggregate(rows);
  const days = new Map();
  for (const row of rows) {
    const key = row.dateKey || '';
    if (!days.has(key)) days.set(key, []);
    days.get(key).push(row);
  }
  const dailyRows = [...days].sort(([a],[b]) => b.localeCompare(a)).map(([day, sessions]) => {
    const group = aggregate(sessions);
    const count = key => group.counted ? formatCount(group.totals[key]) : 'Unavailable';
    return [formatDayLabel(day), sessions.length, `${group.counted}/${sessions.length}`, count('inputTokens'), count('outputTokens'), group.counted ? formatDuration(group.totals.activeMs) : 'Unavailable', count('turns')];
  });
  async function open(id) {
    try {await openSession(id);} catch(caught) {setError(caught.message || 'Could not open the session. Try again.');}
  }
  const sessionRows = rows.map(row => [
    row.title, h('span', {className:'ponytail-id'}, row.sessionId || '—'),
    row.updatedAtMs === null ? 'No update date' : new Date(row.updatedAtMs).toLocaleString('en-US'),
    row.project || row.cwd || 'Unknown',
    // Usage cells follow the same gate as loadHistory: stats is only set when usage
    // was actually reported, so a never-measured session stays Unavailable.
    row.stats ? formatCount(row.stats.inputTokens) : 'Unavailable',
    row.stats ? formatCount(row.stats.outputTokens) : 'Unavailable',
    row.stats ? formatDuration(row.stats.activeMs) : 'Unavailable',
    row.stats ? formatCount(row.stats.turns) : 'Unavailable',
    usageStatusLabel(row),
    h('button', {type:'button', className:'ponytail-button', disabled:!row.sessionId || typeof openSession !== 'function', 'aria-label':`Open ${row.title}`, onClick:() => void open(row.sessionId)}, 'Open')
  ]);
  const rangeOptions = RANGE_OPTIONS.map(option => h('option', {key:option.id, value:option.id}, option.label));
  const projectOptions = [h('option', {key:'all', value:'all'}, 'All projects'), ...catalogProjects.map(value => h('option', {key:value, value}, value))];
  const filters = h('div', {className:'ponytail-filtergrid'},
    h('label', {className:'ponytail-filter'}, 'Session updated date', h('select', {className:'ponytail-select', value:range, onChange:e => setRange(e.target.value)}, rangeOptions)),
    h('label', {className:'ponytail-filter'}, 'Project', h('select', {className:'ponytail-select', value:project, disabled:catalogProjects.length === 0, onChange:e => setProject(e.target.value)}, projectOptions)));
  const summaryText = summary.counted ? `Input ${formatCount(summary.totals.inputTokens)} · Output ${formatCount(summary.totals.outputTokens)} · Turn elapsed ${formatDuration(summary.totals.activeMs)} · Turns ${formatCount(summary.totals.turns)}` : 'Usage unavailable for this selection.';
  // Distinct copy: an empty profile vs a non-empty profile whose filter matched nothing.
  const emptyCopy = history && history.catalogTotal === 0
    ? 'No saved sessions were returned. Use DSH, then refresh to see reported usage here.'
    : 'No sessions match this selection. Widen the date range or pick another project.';
  return h('section', {className:'ponytail-panel ponytail-dashboard'},
    h('h2', {className:'ponytail-h'}, 'Ponytail'),
    h('p', {className:'ponytail-sub'}, 'Whole-session reported usage, grouped by when each session was last updated.'),
    filters,
    h('div', {className:'ponytail-actions'}, h('button', {type:'button', className:'ponytail-button', disabled:loading, onClick:() => setRefreshNonce(nonce => nonce + 1)}, loading ? 'Loading…' : 'Refresh')),
    // While a read runs the previous selection's numbers stay hidden — stale totals are
    // never shown as current.
    loading ? h('p', {role:'status', className:'ponytail-status'}, progress ? `Reading history: ${progress.available + progress.failed} of ${progress.total} selected sessions resolved (${progress.catalogTotal} in the profile catalog).` : 'Reading session history…') : null,
    error ? h('p', {role:'alert', className:'ponytail-alert'}, error) : null,
    !loading && history ? h('div', null,
      h('p', {className:'ponytail-summary'}, summaryText),
      // Coverage is about the selected sessions and the profile catalog only — it never
      // claims all-profile usage totals (unselected sessions were not read).
      h('p', {className:'ponytail-note'}, `Coverage: ${summary.counted} of ${history.total} selected sessions carry reported usage (${history.available} of ${history.total} read for this selection; profile catalog: ${history.catalogTotal} sessions).`),
      history.total === 0 ? h('p', {className:'ponytail-note'}, emptyCopy) : null,
      usageTable('By session updated date', ['Updated','Sessions','With usage','Input','Output','Turn elapsed','Turns'], dailyRows),
      usageTable('Sessions', ['Title','Session id','Updated','Project','Input','Output','Turn elapsed','Turns','Usage status','Action'], sessionRows),
      h('p', {className:'ponytail-note'}, 'Date filters select sessions by their last update; the date window is measured when the read starts, and a session with no update date only appears under All. Only the selected sessions are read — figures cover the whole session, including tool and approval waits in turn elapsed time. Missing usage stays unavailable. Historical test status is not available for saved sessions; the only test evidence is the current process’s last recorded test command in the status band. Cost and savings are not estimated.')
    ) : null
  );
}

/* ---------- apply: registration of all four surfaces ---------- */

function apply(ctx) {
  ctx.inject(['locale', 'slots'], (client) => {
    const t = makeT(client.locale);
    client.effect(() => {
      if (client.locale && typeof client.locale.register === 'function') client.locale.register('ponytail', { en: EN });
    }, 'ponytail: locale');

    client.effect(() => {
      const style = document.createElement('style');
      style.textContent = STYLE;
      document.head.append(style);
      return () => style.remove();
    }, 'ponytail: styles');

    // 1. Profile settings tab (host-owned persistence through the config-form API).
    client.inject(['configForms', 'slots'], (services) => {
      const scope = services.configForms.get('ponytail');
      if (!scope || typeof scope.getSnapshot !== 'function' || typeof scope.mutate !== 'function') return;
      services.slots.inject('settings.plugins.tab', () => services.slots.register({
        name: 'settings.plugins.tab',
        id: 'ponytail',
        key: 'ponytail',
        order: SETTINGS_ORDER,
        label: () => t('title'),
        inject: () => ({ scope }),
      }, SettingsCard));
    });

    // 2. Native mode picker on the bare /ponytail command (no model call to change a mode).
    // remote.commands is a separate injected subservice — injecting only `remote`
    // leaves ctx['remote.commands'] unresolvable (Cordis: cannot get property without inject).
    client.inject(['commandUi', 'remote', 'remote.commands'], (menu) => {
      if (typeof menu.commandUi.decorate !== 'function' || !menu.remote.commands || typeof menu.remote.commands.execute !== 'function') return;
      menu.commandUi.decorate({
        name: 'ponytail',
        available: () => true,
        ui: {
          kind: 'popupSelect',
          options: async () => MODES.map((mode) => ({ id: mode, label: mode === 'lite' ? 'Lite' : mode === 'full' ? 'Full' : mode === 'ultra' ? 'Ultra' : 'Off', detail: MODE_COPY[mode] }))
            .concat([
              { id: 'status', label: 'Status', detail: 'Show the current Ponytail mode for this session.' },
              { id: 'reset', label: 'Reset session override', detail: 'Return this session to the profile default.' },
              { id: 'help', label: 'Help', detail: 'Explain modes, defaults and environment fallback.' },
            ]),
          onSelect: async (option, session) => {
            if (!PICKER_IDS.includes(option.id)) throw new Error('Unknown Ponytail action');
            const result = await menu.remote.commands.execute(session.sessionId, `/ponytail ${option.id}`, []);
            if (!result || !result.ok) throw new Error(resultError(result));
            window.dispatchEvent(new CustomEvent('ponytail-state-change', { detail: session.sessionId }));
          },
        },
      });
    });

    // 3. Status band in the composer dock (host supplies useProjection).
    client.inject(['slots', 'connection', 'remote', 'remote.commands', 'layout', 'configForms'], (services) => {
      const scope = services.configForms.get('ponytail');
      if (!scope || typeof scope.getSnapshot !== 'function' || typeof scope.mutate !== 'function') return;
      services.slots.inject('conversation.input.dock', () => services.slots.register({
        name: 'conversation.input.dock',
        id: 'ponytail-band',
        key: 'ponytail-band',
        order: BAND_ORDER,
        label: () => t('title'),
        inject: (sessionId) => ({ sessionId, connection: services.connection, remote: services.remote, layout: services.layout, scope }),
      }, StatusBand));
    });

    // 4. Dashboard sidebar row + keyed panel.
    client.inject(['slots', 'remote', 'remote.session', 'layout', 'uiWorkspace'], (services) => {
      services.slots.inject('sidebar.panellist', () => services.slots.register({
        name: 'sidebar.panellist',
        id: DASHBOARD_ID,
        key: DASHBOARD_ID,
        order: 50,
        label: () => t('title'),
        inject: () => ({ remote: services.remote, openSession: async (id) => {
          // Await the native open before closing the panel: Dashboard's try/catch must
          // see a rejection instead of a discarded promise.
          if (services.uiWorkspace && typeof services.uiWorkspace.openSession === 'function') await services.uiWorkspace.openSession(id);
          if (services.layout && typeof services.layout.selectPanel === 'function') services.layout.selectPanel(null);
        } }),
      }, (props) => h('span', null, t('title'))));

      services.slots.inject('main', () => services.slots.register({
        name: 'main',
        id: DASHBOARD_ID,
        key: DASHBOARD_ID,
        order: 50,
        label: () => t('title'),
        inject: () => ({ remote: services.remote, openSession: async (id) => {
          if (services.uiWorkspace && typeof services.uiWorkspace.openSession === 'function') await services.uiWorkspace.openSession(id);
          if (services.layout && typeof services.layout.selectPanel === 'function') services.layout.selectPanel(null);
        } }),
      }, Dashboard));
    });
  });
}

return { apply, SettingsCard, StatusBand, Dashboard, loadHistory };
} });
