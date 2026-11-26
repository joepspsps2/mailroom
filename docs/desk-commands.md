# Newsletter desk commands

`bin/mailroom.mjs` (also `@joelincc/mailroom/cli` as `runCli`) is the one set of commands for a whole newsletter issue. It talks to the
admin endpoints of the deployed Worker (see [broadcast.md](broadcast.md)); it never touches the database itself.

```sh
export MAILROOM_URL=https://mailroom.example.com       # the Worker's admin address
export MAILROOM_ADMIN_TOKEN=...                         # the admin token (never put it in a file in the repo)
node bin/mailroom.mjs campaign status weekly-12
node bin/mailroom.mjs --config ./my-defaults.mjs campaign create --issue weekly-12 --post my-post --yes
```

Requires Node 22.18+ (it loads the TypeScript sources directly). Your own defaults (list, sender, template, test addresses…) live in a module
whose default export is a `CliDefaults` (`--config <path>` or `MAILROOM_CONFIG`), or call `runCli(argv, { defaults, env })` from your own script.
Nothing specific to one deployment is built in.

## Rules every command follows

- **Dry run unless `--yes`.** A command that changes anything (including test mail and "mark as previewed") only prints what it *would* do until
  you add `--yes`. Read-only commands (`status`, `audience`, `throttle`, `reconcile`) never need it.
- **Two outputs.** A short summary for people; with `--json` exactly one JSON object on stdout (`{ ok, command, … }`, or `{ ok: false, error }`).
- **Errors say what to do next.** Exit code 1 = refused or failed (nothing half-done is hidden), 2 = wrong usage.
- **Nothing is retried silently.** Failed test mail and unknown outcomes are reported, not resent.

## The flow of one issue

| Step | Command | Notes |
|---|---|---|
| 1 | `campaign create --issue ID (--source file.md \| --post NAME) [--web-url URL] --yes` | Composes the email, runs the pre-send check (it opens the links), saves a **draft**. Same id again updates the draft. Refused if the same web-version URL, source or body already belongs to another non-cancelled issue |
| 2 | `campaign preview ID --yes [--out DIR]` | Marks this exact content as previewed. `--out` also writes `email.html`, `email.txt`, `email-no-name.html`, `check.json`. Approval is refused until this has been done for the current content |
| 3 | `campaign test ID (--to a@x,b@x \| --to-defaults) --yes` | Real postman, real headers, subject prefix; only to the Worker's `TEST_RECIPIENTS` |
| 4 | `campaign approve ID --note "who, when, where" --yes` | Only after the owner has seen the preview and said yes |
| 5 | `campaign schedule ID --at "2027-03-01 09:00" --yes` | Local time (default `+08:00`, `--tz`); a past time is refused. The dry run prints who would receive it per wave. `unschedule` takes it back. `start ID --yes` = schedule for now |
| 6 | `campaign status ID` | State, brake light (green / yellow = a rate is at half its brake / red), counts, rates, why it paused and what to do |
| 7 | `campaign pause ID --reason "…" --yes` | Emergency stop; mail already handed to the provider still goes out |
| 8 | `campaign resume ID --note "what was checked" [--release-domain] [--force] --yes` (alias `release`) | Shows which brake fired, the numerator and denominator and the suggestion. If the sender domain is on hold it refuses until you add `--release-domain` (releases the hold with the same note, then resumes). A pause whose cause must be fixed first (render error, reconciliation mismatch…) needs `--force` |
| 9 | `campaign reconcile ID` | frozen = sent + skipped + failed + uncertain + pending; run again 72 hours after it finished |
| — | `campaign retry-failed ID --yes` | Only while the issue is sending or paused; a finished issue is closed |
| — | `campaign resolve ID --contact N --as sent\|failed --note "…" --yes` | For a recipient left "uncertain" |
| — | `campaign cancel ID --reason "…" --yes` | Not undoable |
| — | `campaign hold release --note "…" --yes` | Release the sender-domain hold on its own; paused issues stay paused |
| — | `campaign audience ID`, `campaign throttle` | Read-only |

## Settings you will want to decide before the first real send

All in `BROADCAST_CONFIG` (see [broadcast.md](broadcast.md#all-settings-broadcast_config)):

- `domainMinComplaints` (default 1): the sender-domain stop needs this many complaints besides the 0.08% rate. With ~220 mails sent a single
  complaint is 0.45%, so with the default one complaint stops every newsletter on the domain. That errs on the safe side; raise it if you would
  rather have a person look first. `campaign resume … --release-domain` is the one-step way out.
- `waveGateMinSent` (default 1): with small waves one bounce can cross the 2% wave gate.
- `startGraceMinutes` (default 360): how late a scheduled issue may start before it goes back to `approved`.
