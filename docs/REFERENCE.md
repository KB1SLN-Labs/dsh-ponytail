# Adapter reference

This is the detailed technical reference for `@kb1slnlabs/dsh-ponytail`. Start with
the [README](../README.md) user guide; come here for commands and default precedence,
migration details, test semantics, technical contracts, and limitations.

## Validation scope

- 64 automated host checks passed before this documentation change.
- The `link:` (local checkout) and `github:` (commit-pinned, tested at GitHub commit
  `37553cd28e3e257e2c952093d54c1dafa8f9ddec`) source acquisitions were
  tested in isolated native rc3 profiles, per the install-sources smoke result. The
  tarball route was tested by the real-host integration suite. No public GitHub release
  asset or npm package exists yet.
- The screenshots demonstrate the actual plugin components on fixture (demonstration) data.
- The final completed real-profile history dashboard has not been visually verified.

## @kb1slnlabs/dsh-ponytail

Ponytail 5.3.3 "lazy senior dev mode" ported to the DeepSeek Harness (DSH) as a
standalone Cordis plugin bundle — an **unofficial MIT port**, tested on Windows with
DSH **0.2.1-rc.3**. One always-on system-prompt section, per-session intensity
switching, and the six upstream skills — no rules rewritten, no bundler, no
TypeScript, no extra external service. On top of that core this build ships the approved
native desktop UI: a Ponytail tab on Settings → Plugins, a native mode picker on bare
`/ponytail`, a status band in the composer dock, and a usage Dashboard (all four
surfaces are implemented and registered; see Native desktop UI below).

**Desktop install status:** this package **is installed on the desktop app**, and the
status band and mode switching were **observed working there**. The automated suites are
real-host service tests (no model calls, no network) and run separately from the
clearly-labelled fixture images shown below. Beyond the observed greeting exchange, **no
live-LLM behaviour is claimed** here.

## Demonstration screenshots

Both images were rendered through the fixture preview harness against the **actual
plugin components** (`client.js`), with explicitly labelled demonstration data:

![Status band expanded, showing ultra mode and provider-reported usage — Demonstration
data rendered through the actual plugin components](../screenshots/status-band.jpg)

*Status band (expanded): Demonstration data, actual plugin components.*

![Dashboard with two sessions carrying usage and one unavailable row — Demonstration
data rendered through the actual plugin components](../screenshots/dashboard.jpg)

*Dashboard: Demonstration data, actual plugin components.*

## Upstream provenance

- Source: <https://github.com/DietrichGebert/ponytail> (MIT)
- Version: **5.3.3** (`v5.3.3` tag line; working tree `v5.3.3-1-g96608e0`)
- Exact upstream SHA vendored here: **96608e078b2d5ea607c5c3b8b5a54d1c1fba6846**
- Vendored verbatim: `skills/*/SKILL.md` (five of six — see the ponytail-help
  exception under Limitations), `hooks/ponytail-instructions.js`,
  `hooks/ponytail-config.js` (kept CommonJS via `hooks/package.json` `"type": "commonjs"`),
  `benchmarks/results/2026-10-07-agentic.md`, and `LICENSE`. The instruction
  builder, mode filtering, default-mode resolution, deactivation-phrase matching,
  and the global default file writer are the upstream implementations — this
  adapter calls them, it does not restate them.
- This adapter's own source repository: <https://github.com/KB1SLN-Labs/dsh-ponytail>
  (the `repository` field in `package.json` points there; upstream Ponytail remains the
  attribution source above). **Neither npm packages nor packaged GitHub releases have
  been published yet** — no `.tgz` is attached anywhere, and nothing has been published
  to npm or any community registry. Build the tarball from source (see Install) until
  releases exist.

## Install (portable — nothing happens automatically)

Two install routes exist; pick the one that matches how your DSH profile is managed.
Either way, **put the `.tgz` in a stable folder first** (somewhere that will not be
cleaned up), and **close any idle DSH process before installing and restart it after**.

The tarball name for this release candidate is
`kb1slnlabs-dsh-ponytail-5.3.3-dsh.5.tgz`. No packaged download is attached publicly yet,
so build it from source — plain JavaScript, so **no `npm install` is needed merely to pack
it**:

```powershell
git clone https://github.com/KB1SLN-Labs/dsh-ponytail.git
cd dsh-ponytail
npm pack --pack-destination ..     # produces ../kb1slnlabs-dsh-ponytail-5.3.3-dsh.5.tgz
```

Use a stable output location for `--pack-destination` — the folder you install the
generated tarball from must survive cleanup, and both install routes below take a
`file:` path to it. Packaged releases and npm installation are not available yet.

### Desktop app — bundled desktop CLI (supported)

An older **globally installed** `dsh` CLI (0.1.5) refuses a `--profile` reference to the
desktop's managed profile — that refusal is about the old global CLI, **not** about the
desktop app. The CLI **bundled inside DSH 0.2.1-rc.3 desktop supports installing into
the desktop profile**. Windows PowerShell:

```powershell
$dshDesktop = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'
& $dshDesktop plugin --profile desktop add 'file:C:/path/to/kb1slnlabs-dsh-ponytail-5.3.3-dsh.5.tgz'
```

`--profile desktop` works with the bundled CLI for `add` / `remove`; note that
`--profile desktop --dump-config` is **intentionally refused even for the bundled CLI**,
so do not expect a dump from it.

Replace `C:/path/to/...` with the stable folder path from above (forward slashes). Then
restart the desktop app. Settings → Plugins is an alternative **only if your DSH build's
Plugins UI actually offers a local-package source** — check that your version provides
it; this reference does not assume a UI capability it cannot verify.

### CLI-managed profiles — ordinary `dsh plugin`

For profiles you manage from the CLI, use the normal command:

```powershell
dsh plugin --profile myprofile add file:C:/path/to/kb1slnlabs-dsh-ponytail-5.3.3-dsh.5.tgz
```

DSH profiles manage plugins with pnpm under the hood: `dsh plugin` forwards `add file:...`
to pnpm in `$DSH_HOME/profiles/<profile>` and then reconciles that profile's
`dsh.profile.bundles` list — a dependency declaring `dsh.bundle.patch` joins the layer
stack, which inserts the bundle's own `cordis.patch.yml` row (`- insert: - id: ponytail /
name: '@kb1slnlabs/dsh-ponytail'`). To pin the mode per profile, restate the row in the
profile's `cordis.patch.yml`:

```yaml
- id: ponytail
  name: '@kb1slnlabs/dsh-ponytail'
  config:
    defaultMode: ultra    # inherit | off | lite | full | ultra
```

### Migration from @mengyuly/dsh-ponytail — remove that plugin first, then replace its row

1. Remove the community plugin itself first: on desktop use the bundled desktop CLI
   above (`... plugin --profile desktop remove @mengyuly/dsh-ponytail`), or for a
   CLI-managed profile `dsh plugin --profile <profile> remove @mengyuly/dsh-ponytail`.
2. Then edit **that profile's** `cordis.patch.yml` (and `$DSH_HOME/cordis.patch.yml`
   if present) and replace the community adapter's specific override row —
   `- id: ponytail / name: '@mengyuly/dsh-ponytail'`, with its `config:` block if it
   has one — with ours. Write it as a **direct override row**, not another `insert:`:

```yaml
- id: ponytail
  name: '@kb1slnlabs/dsh-ponytail'
  config:
    defaultMode: ultra
```

An `- insert:` row here would add a **second base entry** — the base `insert:` for
this package is already contributed by the bundle's own `cordis.patch.yml` once the
package is installed, which stays exactly as it is. The profile-level row only
overrides that same entry; keep any existing `config:` fields you want preserved in
the direct row above rather than adding another insert.

Do **not** delete every `- id: ponytail` row blindly: the profile may carry other
intentional `id: ponytail` rows (for example a mode pin you wrote yourself), and any
row naming a *different* ponytail package is a second override for the same entry,
not a coinstall — replace exactly the community adapter's row.

Removing this package is the mirror image: remove it via the CLI route that matches how
it was installed (desktop: bundled desktop CLI `plugin --profile desktop remove`; CLI:
`dsh plugin --profile <profile> remove`) plus delete its patch rows.

## Usage

- The ruleset is on by default for every assembly **unless the profile sets
  `defaultMode: off`, or another contributor registers a `complete: true`
  system-prompt section** — dsh-system-prompt makes such a complete section the
  entire prompt and this section is then suppressed (host contract; the adapter
  deliberately does not fight it). Levels: `lite`, `full` (upstream default),
  `ultra`. Mode filtering of the level table/examples is upstream's own.
- `/ponytail [lite|full|ultra|off]` — switch this session. Bare `/ponytail` keeps an
  active mode (reports status) or re-enables from off at the configured default
  (`full` when that default is itself off).
- `/ponytail status` · `/ponytail reset` (drop this session's override) ·
  `/ponytail help` · `/ponytail default <mode>` — saves the **upstream global
  default file** (`$XDG_CONFIG_HOME/ponytail/config.json`, else `%APPDATA%\ponytail\config.json`,
  else `~/.config/ponytail/config.json`) and reports write failures. A profile
  `config.defaultMode` still overrides that saved file — `status` tells you which
  source is actually in effect.
- One-shots: `/ponytail-review`, `/ponytail-audit`, `/ponytail-debt`,
  `/ponytail-gain`, `/ponytail-help`. They queue the canonical `<skill_content>`
  (plus any trailing notes you typed, and any attachments you submitted — they
  declare `input.attachments: true` and pass admitted blocks through) as a
  follow-up and **never change the mode**.
- Say exactly `stop ponytail` or `normal mode` (whole message **from you** —
  role `user` with source kind `user`; case/punctuation tolerant) to turn it off
  for the session. A phrase inside a longer sentence is ignored; assistant text,
  tool output, plugin notices, and skill-invocation content are never scanned.

## Native desktop UI (all four surfaces shipped)

`client.js` is the browser-side bundle the host loader runs inside the desktop app
(`window.__ModuleLoader__.load`, `require('react')` from the host — no bundler, no
JSX, no new framework). It registers:

- **Settings → Plugins → Ponytail tab** — profile defaults only: Default mode select
  (`inherit | lite | full | ultra | off`), five optional-skill checkboxes, and the two
  band switches. Save writes through the host config-form mutation API (revision
  guarded; a stale or refused write is reported, never silently merged). *Reset panel
  defaults* clears only this plugin's four own fields.
- **Native mode picker** on bare `/ponytail` (`commandUi.decorate`, `popupSelect`):
  lite/full/ultra/off plus Status, Reset session override and Help. Choosing an option
  runs the ordinary `/ponytail <id>` command — no model call to change a mode.
- **Status band** in the composer dock: current mode select, provider-reported token
  total, active time, Expand/Collapse, Dashboard jump, Hide. Expanded shows input /
  output / cache read / cache write (gated on *reported usage existing*, not merely a
  stats shape), turns, source and profile default, the last recorded test command, and
  Review / Audit launch buttons (disabled until session state is known). The band's
  visibility/expansion come straight from the accepted host snapshot.
- **Dashboard** (sidebar row + keyed panel): whole-session provider-reported usage for
  saved sessions, grouped by last-updated date, with project/date filters, per-day and
  per-session tables, coverage counts, and human-readable usage status per row
  (`No recorded usage`, `Usage unavailable`, `Needs DSH migration`, `Read failed: …`,
  `Missing session identity`). Internal state codes are never shown as product copy.
  Filters are **bounded reads**: the date range and project narrow which sessions get a
  projection read (metadata is filtered first, before any `remote.session.projections`
  call), changing a filter cancels the previous read, and the project list always shows
  every project in the profile catalog.

The screenshots above come from the fixture preview harness: it loads the **actual**
`client.js` components against mock-only host services, with a visible
*Demonstration data* banner (the harness's own fixture chrome is hidden for capture
shots). Production components are untouched by capture mode.

## Config / default precedence

The native settings surface owns exactly **four** profile fields — `defaultMode`,
`disabledSkills`, `showBand`, `expandedBand` — all declared `.volatile()` so the host
commits live config references (loader volatile-update) instead of remounting the
plugin. Headless profiles keep setting them through the bundle row's `config:` block.

1. Session override (`/ponytail <level>`, deactivation phrase) — in-process only.
2. Profile `config.defaultMode` (unless `inherit`) — overrides the upstream chain below.
3. `PONYTAIL_DEFAULT_MODE` env var (upstream).
4. Upstream global config file, written by `/ponytail default <mode>` (upstream).
5. `full` (upstream default).

Invalid `defaultMode` values fail loudly at plugin load; invalid command input is
rejected without touching session state. One-shot commands declare
`input.attachments: true`; the host executor then admits submitted attachments
(or settles as an explicit error when no attachment store is composed) — nothing
is silently dropped. `/ponytail` mode subcommands take no attachments.

## Persistence boundary (honest)

Session overrides live in memory keyed per agent/session id: they survive
compaction and idle turns, but **reset when the process restarts** (resume included).
No per-agent disk files. Session overrides are never written to the profile config —
the native settings tab only writes profile defaults. The global default file is
upstream's and does persist.

## Dashboard history semantics (what the numbers are)

- Figures are the **whole session** as reported by the provider, grouped by the date
  each session was last updated — not a per-day slice of usage.
- Only provider-reported tokens count. A failed attempt that paid tokens is included:
  its usage comes from the embedded stream chunk of that attempt (one source per
  event), which is the honest billed-attempt total, not double counting.
- A fork's inherited seed events are excluded (they were billed in the parent).
- Sessions whose projection is missing, needs migration, failed to read, or reported
  **zero usage reports** stay explicitly unavailable and are excluded from totals;
  coverage counts state exactly how many **selected** sessions carry usage — never a
  profile-wide usage claim, because unselected sessions were not read. A genuine
  zero-token report (`usageReports >= 1`) *is* measured data and stays in.
- The date window is measured when the read starts; a session with no update date only
  appears under **All**. `loadHistory` reports both counts: `total` (selected) and
  `catalogTotal` (every session in profile metadata), plus the full `projects` catalog.
- Time is completed-turn elapsed time and may include approval and tool wait time.
- **No synthetic cost, savings, or reuse estimates** — nothing converts tokens to money.

## Known limitations (explicit)

- Dashboard totals are **whole-session** figures grouped by last-updated date — never a
  per-day slice of a session's usage.
- Date and project filters **limit which sessions get a projection read**, applied to
  metadata before any query; sessions with no update date appear **only under All**.
- Sessions with missing, failed, migration-required, or zero-report usage show as
  **unavailable** and are excluded from totals; coverage counts describe the selected
  set only.
- Cache read/write token counters are reported **separately** from provider input
  totals and are never summed into them. Provider conventions for these counters can
  vary — depending on the provider, cached traffic may or may not be included in the
  reported input figure — so no subset relationship between cache and input counters is
  claimed here.
- "Active time" is completed-turn elapsed time and **includes approval and tool wait
  time**.
- **No cost, savings, or reuse estimates** of any kind are produced.
- Test status: the band shows only the **current process's** last recorded simple
  foreground test command — it is not proof about a whole suite and there is no test
  history.
- Session mode overrides are **not durable** across process restarts; the profile
  `defaultMode` **is** durable.
- Only **Windows with DSH 0.2.1-rc.3** has been verified; other platforms and hosts are
  untested.

## Limitations

- `/ponytail-gain` renders upstream's published benchmark numbers (as of 5.3.3);
  the referenced `benchmarks/results/2026-10-07-agentic.md` is vendored into this
  package at the package root, and the gain skill's rendered resource base is the
  package root — so the skill's own relative path resolves directly from it. Every
  other skill keeps its own skill directory as its resource base. The figures are
  upstream's agentic benchmark (headless Claude Code); nothing was re-measured on DSH.
- `skills/ponytail-help/SKILL.md` is the **single host adaptation**: it describes
  DSH commands/precedence instead of the Claude Code band/update flow. The other
  five skills are upstream verbatim.
- The `@deepseek-ai/dsh-commands` peer is optional: headless profiles without a
  command registry still get the ruleset and skills, just no slash commands.

## Tests

`DSH_ROOT` is **required** and must point at the host DSH package directory (the
directory that contains `node_modules/@deepseek-ai/*`) — there is no PATH/global-CLI
fallback. The suites verify the host `@deepseek-ai/dsh-llm` version is exactly
**0.2.1-rc.3** and fail loudly otherwise.

On test *status* in the UI: historical test status for saved sessions is not
available anywhere. The band shows only the current process's last recorded simple
foreground test command — runner label + exit code from the canonical host
`tools/result` DTO (the same `recordedTestResult` helper index.js feeds the typed
state route), or `Not recorded this process`. It resets on process restart and on
agent disposal; compound/background/timeout/interrupted commands stay unrecorded or
are labelled interrupted, a recorded command exit is evidence for that command only,
and nothing here claims tests passed or scans stdout.

```powershell
cd '<path to your dsh-ponytail checkout>'
$env:DSH_ROOT = '<abs path to the @deepseek-ai/dsh package dir>'   # the durable directory where the host DSH package is installed
npm test        # node --test "test/*.test.mjs" — adapter, metrics and client suites
                # against the REAL host services (Context, SystemPrompt,
                # SkillRegistry, CommandRuntime); no model calls, no network.
                # Isolates XDG_CONFIG_HOME under $env:PONYTAIL_TEST_WORK
                # (default: <os tmpdir>/dsh-ponytail-tests).
node test/tarball-integration.test.mjs   # unpacks `npm pack` output into an isolated
                # scratch profile and mounts THAT tarball through the real Cordis
                # Loader (headless + interactive command smoke, then disposal).
```

Test *status* here is deliberately narrow: no pass count is claimed by this
reference — the parent harness records the current result by running the commands
above against host DSH **0.2.1-rc.3** (`@deepseek-ai/cordis` 4.0.5,
`@deepseek-ai/schemastery` ~3.18.5). The supported runtime is exactly **0.2.1-rc.3**
and the suites fail loudly on any other `@deepseek-ai/dsh-llm` version. These automated
suites run apart from the fixture images above; desktop install plus band/mode
observation is reported separately above, and beyond the observed greeting exchange no
live-LLM behaviour is claimed.

The unit suite stubs the *agent* (`fakeAgent`: inject/followup/session.append) —
it proves handler wiring against real host services, not live model behaviour.
`test/tarball-integration.test.mjs` goes further: real Loader entry mount from an
unpacked tarball with peers resolved through a standard install layout.

## Attribution

Ponytail is by Dietrich Gebert, MIT-licensed; see `LICENSE` and the upstream repo.
This package is an unofficial port. The native UI follows the community DSH
adapter contract shape (`@mengyuly/dsh-ponytail`, MIT — <https://www.npmjs.com/package/@mengyuly/dsh-ponytail>);
where that source was used as a reference, its MIT license governs the copied parts.
