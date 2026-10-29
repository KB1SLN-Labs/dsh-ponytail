---
name: ponytail-help
description: >
  Quick reference for ponytail levels, skills and commands. One-shot display.
  Use for /ponytail-help, "ponytail help", "how do I use ponytail".
---

# Ponytail Help

Display this reference card when invoked. One-shot, do NOT change mode,
write flag files, or persist anything.

(DSH host adaptation: this card describes the DeepSeek Harness commands for
this port. Everything else in Ponytail is upstream verbatim.)

## Levels

| Level | Trigger | What change |
|-------|---------|-------------|
| **Lite** | `/ponytail lite` | Build what was asked, name the smaller option in one line. |
| **Full** | `/ponytail` | The smallest complete change, a check where the logic needs one, and a reply that names what was skipped and any risk. Default. |
| **Ultra** | `/ponytail ultra` | Also questions the request and pushes back before building. |

Level sticks for the session (until changed or the process restarts).

## Skills

| Skill | Trigger | What it does |
|-------|---------|--------------|
| **ponytail** | `/ponytail` | Lazy mode itself: least new code, clear replies that name skipped work and risks. |
| **ponytail-review** | `/ponytail-review` | Quality review of a diff: bugs, security, load, missing tests, speed, what to cut. Each finding says what goes wrong and how to fix it. |
| **ponytail-audit** | `/ponytail-audit` | The same quality review for the whole repo, ranked. |
| **ponytail-debt** | `/ponytail-debt` | Harvest `shortcut:` comments into a tracked ledger. |
| **ponytail-gain** | `/ponytail-gain` | Measured-impact scoreboard: less code, less cost, more speed. |
| **ponytail-help** | `/ponytail-help` | This card. |

In the DeepSeek Harness all six are slash commands (`/ponytail`,
`/ponytail-review`, ...); the model can also load them as skills. The
one-shots queue the skill for the agent and never change your level.

## Deactivate

Say "stop ponytail" or "normal mode" (a whole message from you — a phrase
quoted inside other text does not count). Resume anytime with `/ponytail`.
`/ponytail off` also works.

## Configure Default Mode

Default mode = `full`, active from session start unless overridden. Change it:

**Environment variable** (highest priority):
```bash
export PONYTAIL_DEFAULT_MODE=ultra
```

**Config file** (`~/.config/ponytail/config.json`, Windows: `%APPDATA%\ponytail\config.json`):
```json
{ "defaultMode": "lite" }
```

Set `"off"` to disable auto-activation on session start, activate manually
with `/ponytail` when wanted.

Resolution: env var > config file > `full`. In the DSH adapter a profile's
`config.defaultMode` (unless `inherit`) overrides all three for that profile —
`/ponytail status` reports what is actually in effect, and
`/ponytail default <mode>` saves the global config file above.

## More

Full docs + examples: https://github.com/DietrichGebert/ponytail
