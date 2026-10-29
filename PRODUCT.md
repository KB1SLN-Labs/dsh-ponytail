# PRODUCT — @kb1slnlabs/dsh-ponytail (checkpoint 3: all four native surfaces implemented in the local candidate)

Confirmed product facts (user-approved scope; no invention).

- **What this is.** A packaging of upstream Ponytail 5.3.3 ("lazy senior dev" minimal-code
  ruleset) as a DSH (DeepSeek Harness) Cordis plugin, adapted by kb1slnlabs. Core value is
  unchanged from checkpoint 1: an always-on system-prompt section, per-session intensity
  switching (`/ponytail lite|full|ultra|off`), and the six upstream skills.
- **Purpose of this checkpoint.** Native DSH control-surface parity — and that scope is now
  **implemented**: a settings tab on the native Plugins page, a native mode picker on the
  bare `/ponytail` command, a status band in the conversation composer dock, and a usage
  Dashboard (sidebar row + keyed panel). The band and dashboard were deferred at checkpoint 2;
  that deferral no longer describes this build.
- **Platform.** Web UI running inside Electron (the DSH desktop app). Browser-side plugin
  code is delivered as a `window.__ModuleLoader__.load({ id, factory })` wrapper and gets
  `react` from the host loader — no bundler, no JSX, no new framework.
- **Mode.** Operate mode: implement the approved design faithfully; no redesign, no new
  visual world. Native DSH parity is the binding constraint, and that native-operate visual
  direction (host theme tokens, system-font inherit, scoped CSS) still governs every surface.
- **Audience / language.** English-speaking operator of the DSH desktop app. An English
  locale dictionary is sufficient; the native locale service (`dsh-client-locale`) is used
  so a Chinese dictionary can be added later without restructuring.
- **Persistence boundary.** Profile defaults are host-owned (native settings store, written
  through the host config-form mutation API) and limited to four owned fields: `defaultMode`,
  `disabledSkills`, `showBand`, `expandedBand`. The plugin keeps only in-memory per-session
  overrides. `/ponytail default <mode>` keeps upstream's global file semantics and explains
  that a profile `config.defaultMode` still outranks it.
- **Honest data claims.** Usage figures are provider-reported whole-session totals grouped by
  last-updated date; missing/unmeasured usage stays explicitly unavailable rather than a
  fabricated zero. Time is completed-turn elapsed (may include approval/tool wait). No cost,
  savings or reuse estimates. Test status is limited to the live process's **last recorded
  simple foreground test command** (runner label + exit code from the canonical host DTO);
  compound/background commands stay unrecorded, records reset on process restart and agent
  disposal, and no historical test status exists for saved sessions.
- **Behavioural guarantees that must not regress.** Core prompt injection stays intact when
  optional skills are disabled. Headless mounts with plain config values keep working.
  Defaults from checkpoint 1 (`defaultMode: 'inherit'`, no disabled skills) preserve prior
  behaviour. No control calls an LLM merely to change a mode or a setting.
- **Out of scope.** Install into live profiles / `.dsh/global` modification, publish, model
  calls, per-agent disk state, monetary estimates, and any claim of live desktop runtime
  proof (verification is isolated real-host services plus fixture previews).
- **Provenance / licensing.** Upstream Ponytail (DietrichGebert/ponytail) vendored as before;
  the community DSH adapter `@mengyuly/dsh-ponytail` is MIT and its contract shape is mirrored
  here — attribution kept in README/LICENSE notes.
