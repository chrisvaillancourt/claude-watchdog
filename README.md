# watchdog

A Claude Code mod (function-hook plugin) that reviews what the main agent did each turn and raises short, severity-tagged notes back into the session: `nit`, `concern` or `blocker`. The main model doesn't call it and doesn't choose when to be reviewed. It's a second pair of eyes that reads the ask and the work and stays quiet when there's nothing concrete to say.

It's a port of the idea behind omp's advisor/WATCHDOG, cut down to one reviewer. It has nothing to do with Claude Code's built-in `/advisor` (where the model chooses to consult a stronger model) and doesn't touch it.

It's **off by default**, since every review is a model call billed to you.

## Behavior

- **What it reviews.** Turns of the main conversation that end with an answer. Every `reviewInterval`th such turn triggers a review; skipped turns are folded into the next one. Subagents' own turns, interrupted turns and failed turns are never reviewed, and neither is a turn watchdog itself started.
- **What the reviewer sees.** Your prompt, the tool calls the agent made (tool name and the key arguments: paths, commands, patterns, the text written by `Write`/`Edit`), an excerpt of each result (errors kept longer), and the final answer, held to `maxDeltaChars` in total (markers included). The newest request and answer always go in together (both cut to share the room if they don't fit), then older prompts and answers, newest first, then the newest tool calls that fit; older items are left out with a marker saying how many. Everything stays in the order it happened. Plus your `WATCHDOG.md` guidance, if any. It doesn't see the agent's intermediate narration or thinking: a reviewer judges the work better without the author's story.
- **What comes back.** At most `maxNotes` nits and concerns per review (blockers aren't capped). Content-free notes ("lgtm", "no issues") are dropped. Copies of one note in a review are merged into the most severe copy, and a note that repeats an earlier one at the same or a lower severity is dropped. If the reply contains, anywhere (inside or outside its notes, before any cutting), an instruction override ("ignore previous instructions") or any destructive shell command that wasn't itself in the reviewed work, word for word (each one is checked on its own, quoted operands included, so quoting a command the agent ran never vouches for a different one, and a command whose end can't be told, such as one with `$(…)`, a line continuation or a heredoc, is never vouched for), the whole reply is quarantined and nothing from it is delivered.
- **Where notes go.**
  - Concerns and blockers are added to the conversation as a hidden message the model reads on its next request. It starts with the request it's about ("Watchdog notes on your answer to: …").
  - Nits are shown to you (a notice in the transcript and a toast) and never sent to the model.
  - If the turn has ended and a note is at or above `continueSeverity` (default `concern`), watchdog wakes the agent with one new turn asking it to address the notes or say why not. After a wake, concerns can't wake it again for `immuneTurns` turns; blockers can.
  - Notes for a turn that's no longer the latest (you started another turn while the review ran) aren't sent to the model at all. You see them as a late notice instead.
  - If you interrupted the turn, it's never woken.
- **Failures.** An API error, a timeout, an empty reply, or a reply whose notes can't be read (no `<notes>` block, or text in it that isn't a note) is counted as "review incomplete" and shown in `/watchdog status` and the log. It's never reported as approval.
- **Headless sessions** (`claude -p`, the SDK) are skipped unless `reviewHeadless` is on. Then the review runs before the process exits and its notes are written to the log (below); there's no wake, and on Claude Code 2.1.310 a note appended after a `-p` run's answer isn't kept in its transcript.
- **What it never does.** It never gives the reviewer tools, never changes the main session's model, system prompt or tool list, never reviews subagents, and never registers or intercepts `/advisor`.

## Command

```text
/watchdog            status (same as /watchdog status)
/watchdog on         turn reviews on for this session
/watchdog off        turn reviews off for this session; an in-flight review is discarded
/watchdog review     review what has happened since the last review, now
/watchdog status     on or off, reviews run, notes delivered, tokens used
```

## WATCHDOG.md

Reviewer-only guidance: what the reviewer should hold the agent to (project rules, things it keeps getting wrong). The main agent never reads it. watchdog reads, in this order, and joins what it finds:

1. `~/.claude/WATCHDOG.md` (yours, for every project)
2. `<project root>/WATCHDOG.md`
3. `<project root>/.claude/WATCHDOG.md`

The project root is the session's root (where it started, or where `/cd` moved it). Each file is read at review time, so edits apply to the next review. Guidance is capped at 8,000 characters in total; the rest is cut with a marker.

## Options

Set in `/config`, or in settings under `pluginConfigs["watchdog@watchdog"].options` (the key is the plugin id, `<plugin>@<marketplace>`):

| Option | Default | What it does |
| --- | --- | --- |
| `enabled` | `false` | Turn reviews on for new sessions. `/watchdog on\|off` overrides it per session. |
| `model` | `sonnet` | The reviewer's model: an alias (`haiku`, `sonnet`, `opus`) or a full model id. `haiku` is the cheap option, but in one live check at low effort it stayed silent on a bug it caught at another time. |
| `effort` | `medium` | The reviewer's effort: `low`, `medium`, `high`, `xhigh` or `max`. |
| `reviewInterval` | `1` | Review every Nth answered turn (skipped turns are included in the next review). |
| `continueSeverity` | `concern` | Lowest severity that wakes a finished turn: `concern`, `blocker` or `never`. Nits never wake. |
| `immuneTurns` | `3` | After a wake, how many main turns concerns can't wake again. Blockers are exempt. |
| `maxNotes` | `4` | Nits and concerns admitted per review. Blockers aren't capped. |
| `maxDeltaChars` | `24000` | Characters of turn evidence sent per review. |
| `timeoutSeconds` | `120` | How long one review may take before it's abandoned as incomplete. |
| `reviewHeadless` | `false` | Also review in headless sessions (`-p`, SDK). No wake there. |

## What it costs

One `$.model.complete` call per review, on the `model` option, billed to your session's credentials. It's bounded by the options:

- **Input:** a fixed reviewer prompt of about 900 tokens, at most 8,000 characters of WATCHDOG.md guidance (about 2,000 tokens) and at most `maxDeltaChars` of evidence, a hard ceiling (24,000 characters, about 6,000 tokens). So at most about 9,000 input tokens a review; a short turn is a few hundred to a couple of thousand.
- **Output:** at most 1,024 tokens; usually under 200.
- **How often:** at most once per answered main turn (`reviewInterval` 1), plus one per `/watchdog review`. A wake starts one more main turn, billed like any other turn.

Completions don't show up in Claude Code's session cost or `/cost`, so watchdog keeps its own count: `/watchdog status` shows the session's reviews and tokens, and each review is logged as a JSON line in `~/.claude/watchdog/<session id>.jsonl` (model, token counts, the notes delivered with their text, how many the guard dropped, outcome, and the reviewer's raw reply when it raised nothing or couldn't be read).

### Why a completion, not a subagent or a fork

- `$.model.complete` sends a compact, bounded summary to a model you choose, returns its exact token usage, and can be timed out. Its weakness: the reviewer can only judge what's in the evidence; it can't open files to check a suspicion.
- A forked side question (`$.model.fork`) would reread the whole conversation on the main model each review (cheap per token when cached, but large and counted against your plan's usage), and it would see the agent's own reasoning and justifications, which make a reviewer more forgiving.
- A read-only reviewer subagent could investigate with Read and Grep, but each investigation step rereads its context, so a review costs several times more, and its report has its own delivery path into the main session that would need to be proven not to bypass the quarantine.

## Limitations

- **One reviewer, final-answer cadence.** omp can run several reviewers with their own scopes and models, and can review each tool-call round. watchdog runs one, at the end of a turn.
- **No investigation.** The reviewer has no tools; it can't verify a claim against files that aren't in the evidence. Evidence is truncated, so a bug in a cut part of a long file can be missed.
- **Plan mode isn't detected.** A wake in plan mode starts a turn in plan mode (the agent can't edit there, but it does spend a turn). Set `continueSeverity` to `never` if that bothers you.
- **A note can land just after you start a new turn.** watchdog checks right before adding a note that the turn it reviewed is still the latest, but there's a moment between that check and the append it can't close. A note that lands then names the request it was about, so the agent can tell it concerns earlier work.
- **Late notes aren't held for later.** A note about a turn you've already moved past is shown to you, not queued for the model's next turn. omp keeps such notes, marked with their age, for the agent's next turn; watchdog doesn't in v0.1.
- **One review at a time.** A turn that ends while a review runs is folded into one follow-up review.
- **The quarantine is a heuristic.** It catches the common forms of instruction overrides and destructive commands (`rm -rf`, `git reset --hard`, force pushes, `git clean -f`, `find -delete`, `mkfs`, `dd` onto a device, `DROP TABLE`), not every phrasing. A command counts as quoted only when the evidence holds the same command word for word, read up to a backtick, newline or shell separator outside quotes; a note that runs prose on after a quoted command without backticks is quarantined, which errs on the safe side.
- **Another plugin can hide rows from it.** A plugin seated above watchdog can send a row past watchdog's hook (the debug log says `session.append bypassed by <plugin>`); that row isn't part of the evidence.
- **Severity is the reviewer's opinion.** A `blocker` tag doesn't make a note right. The wake message asks the agent to weigh the note against the evidence.

## Install

```sh
claude plugin marketplace add chrisvaillancourt/claude-watchdog
claude plugin install watchdog@watchdog --scope user
```

Or from inside Claude Code: `/plugin install watchdog --marketplace chrisvaillancourt/claude-watchdog`.

To work on it locally, add your clone as the marketplace instead (`claude plugin marketplace add <path to clone>`). The plugin is read from that folder; after editing, run `/reload-plugins`.

## Update

```sh
claude plugin marketplace update watchdog
claude plugin update watchdog@watchdog
```

Then restart Claude Code.

## Develop

```sh
scripts/check.sh
```

It runs `claude plugin validate .`, `claude plugin test .` and a TypeScript check. Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/).

## License

MIT. See [LICENSE](LICENSE).
