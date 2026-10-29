# DESIGN — native DSH settings panel, mode picker, status band, dashboard (checkpoint 3)

Visual authority: **the established native DSH desktop UI world**. This is a precise native
extension, not a new visual world; no options were needed and none were invented. That
native-operate visual direction binds every surface shipped in this checkpoint — settings tab,
mode picker, status band, and dashboard alike. Parent has read `new-work / operate /
craft-floor / init` context (impeccable `context.mjs` run once).

## Platform facts that bind the design

- Browser plugin form: `window.__ModuleLoader__.load({ id, factory: (require) => … })`, CJS
  body, `const React = require('react')`, `React.createElement` only. Host loader demands this
  wrapper, not an ESM default export.
- Package metadata: `exports["./client"] = "./client.js"`, `files` whitelist includes
  `client.js`, `dsh.client = { platform: 'web', inject: [native package ids] }`.
- Services used (verified present in rc.3 runtime, exact community contract):
  - `ctx.inject(['locale','slots'])` — locale dictionaries + slot registration.
  - `configForms.get('ponytail')` → bound scope with `getSnapshot()`, `subscribe()`,
    `mutate(ops, expectedRevision)`; snapshot `{ value, revision, writable, status }`;
    `mutate` returning `false` means host refusal.
  - `slots.inject('settings.plugins.tab', () => slots.register({ name, id:'ponytail',
    key:'ponytail', order:30, label, inject: () => ({ scope }) }, SettingsCard))`.
  - `ctx.inject(['commandUi','remote'])` → `commandUi.decorate({ name:'ponytail', available,
    ui:{ kind:'popupSelect', options, onSelect } })`; `onSelect` calls
    `remote.commands.execute(session.sessionId, '/ponytail <id>', [])`.
  - Band: `slots.inject('conversation.input.dock', …)` with the host-provided
    `useProjection('ponytailStats')` hook (always called before any conditional return),
    typed state over `connection.rpc.call('/api','ponytail/state',{sessionId})`, and band
    preference writes through the same config-form scope.
  - Dashboard: `slots.inject('sidebar.panellist', …)` + keyed `slots.inject('main', …)` with
    id `ponytail-dashboard`; history comes from `remote.session.list` /
    `remote.session.projections` through the exported pure `loadHistory` (max 4 concurrent
    reads, abort-aware). `loadHistory(remote, signal, { updatedSince, project, onProgress })`
    filters **metadata before any projection read**: `updatedSince` is a finite epoch-ms
    cutoff or `null` (= All, default), `project` is a string defaulting to `'all'`. It
    returns `{ rows, total, available, failed, catalogTotal, projects }` — `total`/`rows`
    are the *selected* set, `catalogTotal` and `projects` always describe the whole profile
    metadata so the filter controls stay complete while a narrower read runs. Progress
    reports `{ total: selectedCount, available, failed, catalogTotal, projectCount }`.
- Server half: `ctx.inject(['settings'])`, `settings.configure({ auto: false }, ctx.fiber)` so
  the native Plugins tab replaces the host's auto-generated form; volatile Config fields are
  what the host can edit live (`loader/volatile-update` commits refs without remount).

## Theme tokens — inherited, never redefined

All styling uses the host's `--dsw-alias-*` variables already in the desktop shell:
`--dsw-alias-border-l4`, `--dsw-alias-bg-layer-2`, `--dsw-alias-bg-layer-3`,
`--dsw-alias-label-primary`, `--dsw-alias-label-secondary`, `--dsw-alias-brand-primary`.
No new palette, no hard-coded theme colours, no font declarations — **system font inherit**
(`font: inherit` on controls only). Scoped CSS only: one `<style>` element with `.ponytail-*`
class prefix, registered through the plugin's own `effect`, removed on disposal. No global
selectors, no `!important`.

## Layout & states (SettingsCard)

- Panel order mirrors native settings cards: title → one-line description → boundary note
  (profile defaults vs session override) → status line → Default mode select (+ keyboard-safe
  detail) → optional-skills fieldset (5 checkboxes) → band switches (`showBand`, `expandedBand`)
  → Save / Reset panel defaults → status/alert line → `<details>` help.
- **Labeled fields** (native `<label>`, `<fieldset>/<legend>`), `aria-describedby` for hints,
  `role="status"` / `role="alert"` messages. Help is reachable by click and keyboard; nothing
  is hover-only (hover merely short-circuits the same detail block).
- **Disabled states**: every control disabled while `busy`, `!writable`, or `status !== 'ready'`
  (loading / unavailable / read-only). Save disabled until a draft exists.
- **Error path**: on mutation failure or host refusal (`false`), the draft is preserved, a
  localized `alert` message shows, and nothing silently reverts.
- **Reset** sends `op:'unset'` for *owned fields only* (`defaultMode`, `disabledSkills`,
  `showBand`, `expandedBand`) — it never touches other namespaces or session overrides.
- Focus ring: `:focus-visible` outline in `--dsw-alias-brand-primary`, matching native cards.

## Status band

Mode select (writes through `/ponytail <mode>`), provider-reported token total, active time,
Expand/Collapse and Hide (persisted through the host scope; appearance is read back from the
accepted snapshot so a refusal cannot desync the UI), Dashboard jump. Expanded adds input /
output / cache read / cache write — gated on *reported usage existing* (`usageReports > 0`),
not merely a valid stats shape — turns and active time (gated on the stats shape), source and
profile default, the last recorded test command, and Review / Audit launchers disabled until
the typed session state (and its disabled-skill list) is known. Test status copy is exactly
the recorded runner + exit code, `…: interrupted`, or `Not recorded this process`; a recorded
exit is stated as evidence for that command only.

## Dashboard

Whole-session provider-reported usage grouped by last-updated date: date and project filters,
a per-day table and a per-session table, coverage counts (`with usage / selected sessions`,
plus the profile catalog size), and Refresh with abort-safe supersession. Filters are **bounded
reads**: changing range or project re-runs `loadHistory` with its own `AbortController`, so only
matching sessions ever reach `remote.session.projections` (a 924-session profile with 3 recent
sessions performs 3 reads, not 924), the previous read is aborted, and a late aborted outcome can
neither replace the current rows nor clear the current loading state. The date window is computed
when the read starts (`Date.now()` at read time); an undated session only appears under All. The
project dropdown keeps every catalog project across filters — a selection never resets it. While
a read runs the previous numeric results are hidden rather than shown as stale. Empty profile and
no-matching-filter are distinct copy. Row status renders human-readable
copy — `No recorded usage`, `Usage unavailable`, `Needs DSH migration`, `Read failed: <reason>`,
`Missing session identity` — never an internal state code. Missing/unmeasured usage stays
`Unavailable` in every numeric cell and is excluded from totals; the footer states that date
filters select by last update (measured when the read starts), that only selected sessions are
read, that figures are whole-session (turn elapsed may include approval and
tool waits), and no cost or savings are estimated.

## Picker (popupSelect)

Options are ordinary valid commands only: `lite | full | ultra | off | status | reset | help`.
No current-mode highlight — the host option payload does not expose a typed selection, so
inventing one (or parsing status text) stays out; the band shows the effective mode instead.
`onSelect` validates the id against that enum before executing, and throws on `!result.ok` so
the host surfaces the failure.

## Motion & claims

No decorative motion, no transitions, no animation. No synthetic savings/impact numbers: the
skills panel describes what each skill does; the upstream benchmark reference is labelled as an
upstream reference, not a measured result for this project. Test-status copy is limited to the
live process's last recorded simple foreground test command from the canonical DTO — compound,
background, and operator-composed commands are never recorded or implied.
