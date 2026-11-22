# mend: one patch tool for every AI edit format

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/masoplek1011/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/masoplek1011/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

**mend** applies an edit an AI model wrote to a tree of text files — in any of the four formats models actually write: a unified diff (often with wrong line numbers), SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool calls as JSON. It finds each edit's lines at the first of three matching tiers (exact, trailing whitespace, full trim with re-indent), and writes every change or none at all.

- Four formats, one tool: unified diff, SEARCH/REPLACE, V4A, JSON edits — detected automatically, or forced with `--format=NAME`.
- Three-tier line matching, plus `--strict` for exact-only matching.
- Atomic: a failed edit changes nothing, later edits still run, and every failure is reported; with `--check` nothing is written at all.
- Exact output and exit codes per `SPEC.md`: `A`/`D`/`M`/`R` lines plus `ok: n files`, or `error: …` plus `failed: k of n edits`.
- Node 22, standard library only; no model call, no key, no network, no build step. Deterministic: no clock, no unseeded randomness.

## Run it

```sh
node main.ts [options] [PATCH]
# PATCH is a patch file, or - / omitted to read the patch from standard input.
#   --format=unified|search-replace|v4a|json|auto   (default auto)
#   --check    report what would change, write nothing
#   --strict   match lines exactly (tier 0 only)
```

## Files

- `main.ts`: the CLI. `SPEC.md` is the whole contract.
- `check.ts`: the practice set on your own machine — `node check.ts <practice.json>` (100 checks; this entry passes 100/100).
- `runner.ts`: the trial runner; kept as the kit has it.
- `SPEC.md`: the specification (version 1).

## Example

```sh
# apply a unified diff to the tree in the current directory
node main.ts fix.patch
# M src/app.ts
# ok: 1 file

# preview a V4A patch without writing anything
node main.ts --check --format=v4a change.diff
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=joedsor&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
