# Coding agent guidance

## Repository interaction

This repository is hosted on the user's self-hosted Forgejo instance:
https://git.core.home.timcinel.com/tim/co-larger/

Work is tracked in the project board:
https://git.core.home.timcinel.com/tim/co-larger/projects

- Use the `fj` CLI to interact with this repository on Forgejo.
- Use the `forgejo-project` script to interact with Forgejo projects.
- Use the `forgejo-logs` script to read Forgejo Actions runs and job logs,
  which `fj` cannot fetch. For example:
  - `forgejo-logs pr <number>` shows the latest CI run for a pull request and
    the failed job's log (add `-f` for failure lines only, `-n 50` for the
    tail).
  - `forgejo-logs runs`, `forgejo-logs jobs <run>` and
    `forgejo-logs log <run> [-j <job>]` list runs, a run's jobs, and a job's
    log.
  - `forgejo-logs rerun <run>` re-runs a run, for example after a flaky
    failure. Record the flake in the relevant issue.
- The Forgejo Git remote is named `core`. Treat it as `origin` and the
  default upstream: `git fetch core`, `git merge core/master`,
  `git push -u core <branch>`.
- Avoid computer use; prefer CLIs and APIs.

## Issue workflow

Once you have picked an issue and read it:

- Let the user know if you have any questions before beginning implementation.
- Rename the chat to `<repo>#<issuenumber> <very short description>`. Use the
  app's chat-title tool, or its local session files if needed.
- Record interesting findings and roadblocks in issue comments.
- Update the ticket's project state to **In Progress** when resuming work.
  Set it to **Blocked** when expecting to wait for more than one hour.
- Update the issue's acceptance criteria checkboxes as you verify each criterion.
- When blocked, prefix the original issue title with
  `(BLOCKED: <2–3 word reason>)`, for example
  `(BLOCKED: Checking backups) <original issue title>`.
- Ping the user on Telegram when their attention is needed. See
  `~/private/telegram-notifications` for instructions.

## Changes and pull requests

- Use branches and pull requests for changes to `master`; do not push changes
  directly to `master`.
- For UI changes, capture screenshots demonstrating the changed behaviour and
  include them inline in both the chat update and the pull request description.
  Include before-and-after screenshots when they help explain the change.
- Upload UI screenshots as pull request attachments or store them in the
  repository so the images in the pull request remain accessible to reviewers.
- Wait for CI to complete successfully before merging pull requests.
- If `fj pr merge` rejects the merge (for example HTTP 405), fetch
  `core/master` again and merge it into the branch, resolve any conflicts,
  re-run the tests, push, wait for CI, then retry the merge.
