# OLL-E — Starter versioning and distribution

Status: **plan, not implementation**. This document settles the design direction for versioning starters, updating locally-modified installs from upstream, and eventually hosting a community starter repo. Nothing here is built. See `REFERENCES.md` (pi-mono entry) for the prior-art study behind it.

## The problem

Starters ship as TypeScript template files embedded in the binary — `src/starters/templates/*.ts`, nine starters, 3,646 lines / 140KB of file bodies wrapped in `String.raw`. Three failures are already visible:

1. **The embedding doesn't scale.** Every starter is source code masquerading as a string literal: no syntax checking, no direct execution, painful diffs. The roadmap adds email and calendar starters; the telegram starter alone is 875 lines of wrapped strings.
2. **There is no update path.** `install_starter` copies files and commits; from that moment the installed copy and the shipped template share no link. When upstream fixes a bug (the discord starter's 429-retry hardening is exactly the kind of fix that should reach existing installs), the only options are manual re-porting or `overwrite: true`, which destroys the agent's local modifications. And local modification is not an edge case — it is the premise. Agents clone starters *and modify them*; the vision's "grown by its inhabitants" means every installed starter is expected to diverge.
3. **There is no community story.** A starter someone else grew — a Slack bridge, a Matrix adapter — has no way to reach another host except copy-paste through a chat window.

The asset we already hold: `~/.olle/extensions/` is a git repo where every agent write is a commit. The update problem is a three-way merge problem, and we already own the merge machinery.

## The pi-mono pattern

Pi (references/pi-mono; `packages/coding-agent/docs/packages.md`) distributes extensions, skills, prompts, and themes as **plain npm packages or git repos**. The whole install grammar is a source string: `pi install npm:@foo/bar@1.0.0`, `pi install git:github.com/user/repo@v1`, or a local path. A `pi` key in `package.json` declares resource globs; absent that, conventional directories (`extensions/`, `skills/`, …) auto-discover. The source string lands in a settings JSON; that record *is* the installation. Pins never move implicitly — `pi update --extensions` reconciles a clone to the recorded ref (`git reset --hard` + `git clean -fdx`, package-manager.ts `ensureGitRef`) but adopting a newer version is an explicit re-install with a new ref. Discovery is registry-less: npm is the registry, and the `pi-package` keyword drives the pi.dev/packages gallery (5,000+ packages) with no submission process at all.

**What we take:** the source-string grammar (`repo@ref` is the entire package format — no registry server, no manifest beyond the repo's own shape); pins that never move implicitly; registry-less discovery riding infrastructure someone else already runs.

**What we leave:** pristine installs. Pi's answer to "installed but modified" is *don't* — reconcile hard-resets the clone; your own code lives in a separate auto-discovered directory or your own fork. That split is exactly what OLL-E cannot adopt: our installed copy and the agent's modifications are the same directory by design. We also leave npm as a channel (extensions are Bun-only with no third-party deps; `npm install` inside the agent-writable surface imports the whole node_modules supply chain) and the settings-file install record (provenance belongs in the extension's own `manifest.json`, the visible authority boundary).

## Prior art, compressed

| Ecosystem | Unit | Version pin | Local-mod + update | Registry |
|---|---|---|---|---|
| pi packages | npm pkg / git repo | npm version / git ref, explicit moves | none — pristine reset; fork or local dir | npm keyword → gallery |
| Homebrew taps | git repo of formulae | per-formula version+sha256; tap tracks HEAD | none — make your own tap | naming convention + GitHub |
| oh-my-zsh | one framework clone | HEAD | `custom/` overlay shadows upstream; no merge | none |
| Obsidian plugins | GitHub Release assets | release tag = manifest version | none — update overwrites | one JSON file in one repo, join by PR |
| lazy.nvim | git repo per plugin | branch/tag/commit + `lazy-lock.json` SHAs | `dev.path` swap; managed clone gets clobbered | none — `owner/repo` shorthand |
| Claude Code marketplaces | git repo / subdir / npm | `sha` beats `ref`; commit SHA as implicit version | none — copied to cache; fork instead | `marketplace.json` in any git repo |
| deno.land/x → JSR | git tags → central registry | immutable tag versions | n/a | webhook registry; abandoned for JSR |

Two lessons. First, **nobody supports locally-modified installs plus upstream update** — every system either overwrites (Obsidian, Claude Code), hard-resets (pi, lazy.nvim), or side-steps via overlay/fork (oh-my-zsh, Homebrew). The mechanism that *does* solve it is plain git: fetch upstream, three-way merge against the recorded base, resolve conflicts. Agents resolve conflict markers well; the ecosystems above avoid merging because their consumers are humans who don't. Our consumers are agents. Second, deno.land/x is the cautionary tale on the registry side: pure git-tag distribution worked, and Deno still abandoned it for integrity metadata and discoverability at ecosystem scale. We accept that ceiling knowingly — at nine starters and a v0 trust model of "the friend you handed the code to," a registry server is complexity that has not earned its place.

## Versioning scheme

**Canonical repo.** One public git monorepo (working name `olle-starters`), one directory per starter, each directory exactly the extension layout (`manifest.json`, `index.ts`, `smoke.ts`, `SETUP.md`). Per-starter tags `<name>/vX.Y.Z`. A generated `index.json` at the root lists `{name, version, description, path, tag}` per starter — the Obsidian pattern, regenerated from manifests by CI, never hand-edited. Consumption is git protocol (fetch/clone, shallow + sparse where it helps), **not** raw-URL fetch: GitHub throttles unauthenticated raw fetches per-IP with no published limit, while git fetch is the reliable path.

**Manifest field.** `manifest.json` gains an optional `upstream` block — the install record, living where the authority boundary already lives:

```json
"upstream": {
  "repo": "https://github.com/<org>/olle-starters",
  "subdir": "telegram",
  "ref": "telegram/v0.2.0",
  "commit": "<40-char sha at install/last sync>"
}
```

`commit` is the merge base and the only true pin — tags are mutable in principle, so `commit` beats `ref` (Claude Code's rule, adopted). The existing required `version` field stays semver and states what the local copy *is derived from*; local divergence is visible as git history after the last sync commit, not as a version-string mutation. Any git URL is a legal `repo` — the canonical monorepo is the default, not a privilege. Community starters are the same mechanism pointed at a different repo.

**Merge mechanics: per-file three-way, not subtree.** Update = `git fetch <repo> <tag>` into the local extensions repo (upstream objects land in the local object store), then per file: base = `upstream.commit:<subdir>/<file>`, theirs = `<new-commit>:<subdir>/<file>`, ours = the working copy — `git merge-file`, conflict markers left in place. File-level rules: upstream-added → add; upstream-deleted and locally-unmodified → delete; upstream-deleted but locally-modified → keep + flag; local-only files untouched. Rejected alternative: `git subtree add/pull --squash`. Subtree performs a true history merge, but it requires installs to have been subtree-adds (ours are plain file writes, nine starters already installed in the wild), records its merge base in commit-message archaeology rather than data, and entangles the extensions history with merge commits. `merge-file` needs only the three contents, all of which the fetch provides, and its output — a working tree with conflict markers — is exactly the artifact an agent is best equipped to finish. Existing installs that predate the `upstream` field fall back to the pristine `install starter: <name>` commit already in local history as the merge base, and get stamped on first sync.

**New core meta-tools** (extension-authoring family — same reasoning that put `write_extension` in the binary: machinery that operates on the extensions repo's own git story is substrate, not something the loop can grow without a bootstrap paradox):

- `check_starter_updates` (operational, read-only) — fetch upstream refs / `index.json`, compare against each installed extension's `upstream`, return `{name, installed, latest, changed}`. Also how third-party repos are inspected before adoption.
- `merge_starter_upstream(name, ref?)` (strategic) — the mechanical half: fetch, three-way merge, write results including conflict markers, stamp `upstream` to the new ref+commit, commit the pre-resolution state with agent attribution. Returns the conflict list. Does **not** register.
- `install_starter` grows a `repo` parameter (default: embedded snapshot; any git URL accepted) and stamps `upstream` on every install.

Determinism stays in the substrate, cognition inside the turn — the fetch and merge are mechanical; deciding *whether* to update, resolving conflicts, and judging the result are agent work.

## The update flow, concretely

Scenario: the human installed the telegram starter three months ago at v0.2.0. The agent has since rewritten the message-chunking logic (normal `write_extension` commits). Upstream ships v0.4.0 with the 429-retry fix.

1. **Awareness.** Nothing in the daemon polls upstream. A standing job — a cron'd natural-language instruction, pure composition of existing primitives — runs weekly: "check starter upstreams; propose updates worth taking." Its turn calls `check_starter_updates`, sees `telegram v0.2.0 → v0.4.0`.
2. **Propose.** The agent files an inbox decision (strategic — same tier `install_starter` already carries, because adopting remote code is adopting code): the version delta, the upstream changelog, a note that the local copy has diverged (git log since the last sync commit names its own chunking work), the plan (merge → resolve → smoke → register), and the rollback (`revert_extension` to the current sha). Then it keeps working. Nothing blocks.
3. **Approve.** The human replies `approve` through whatever channel their inbox reaches them on. Staleness policy applies like any other decision.
4. **Merge.** `merge_starter_upstream("telegram")` fetches `telegram/v0.4.0`, three-way merges each file against the v0.2.0 base. The retry fix in `index.ts` overlaps the agent's chunking rewrite: one conflict. The tool commits the merged-with-markers state (attributed to the agent) and reports `conflicts: ["index.ts"]`.
5. **Resolve.** The agent reads the conflict (`read_extension_file`), keeps its chunking, takes upstream's retry logic, writes the resolution (`write_extension` — a normal attributed commit).
6. **Smoke.** `run_smoke_test("telegram")` probes the wire format against the live API.
7. **Register.** `register_extension("telegram")` hot-loads; auto-load-on-register refreshes the thread's tool schemas. The agent reports the outcome on the thread the human is watching.
8. **Any failure** — smoke fails, load throws, or the merged code crashes later — lands on the existing rails: `revert_extension` back to the pre-merge sha (one command, the whole update including the `upstream` stamp unwinds), inactive-with-inbox-item on load failure, crash-threshold auto-disable after.

One approval, async, covering the whole update. No new primitive: two tools, one standing job, and the loop that already exists. Vision check: no privileged path (there is deliberately **no** `olle starter update` write command — the human asks in chat and the same handler serves every channel; CLI parity stays read-only, e.g. `olle starters` listing); nothing blocks on humans; the update *is* the propose→write→smoke→hot-load loop, not a bypass of it; host sovereignty holds because fetching code is proposing code, never executing it — nothing runs until register, after smoke, after approval.

## Hosting: GitHub, not ants.land

**What ants.land actually is** (fetched 2026-07-11): an npm-compatible package registry (`npm.ants.land`) belonging to Ant, a new JavaScript runtime by a solo developer (theMackabu; antjs.org). It is genuinely agent-first — `POST /api/agent/register` returns a bearer token with no browser or email, there's a `/.well-known/ants-registry.json` machine spec and a `skill.txt` for agents — which makes it philosophically the closest thing to a registry built for inhabitants rather than developers. And it is unusable as our substrate: it hosts npm tarballs, not git repos, so the merge-base mechanics above have nothing to grip; unclaimed agent accounts **and everything they published are deleted after 12 hours** unless a human claims them; and there is no identified operator, no pricing, no reliability story — the HN launch drew provenance and performance skepticism. A distribution channel whose failure mode is "the packages evaporated" cannot carry the world's capabilities. Watch it, don't build on it. Resurrect-when: it gains an operator story and git (or content-addressed) semantics.

**GitHub monorepo, git-protocol consumption.** One repo, per-starter tags, index.json — battle-tested twice (Obsidian at ~2k plugins, Claude Code marketplaces) with near-zero infrastructure. Monorepo over repo-per-starter because at this scale one PR surface, one CI, and one index beat nine repos, while per-starter tags keep versioning independent and sparse/shallow fetch keeps per-starter consumption cheap. The design is not GitHub-*dependent*: `upstream.repo` is any git URL, so a community starter in someone's self-hosted Gitea works identically, and moving the canonical repo is a one-field change. GitHub is the boring default, not a coupling.

## Migration from binary-embedded starters

- **Phase 1 — invert the source of truth.** Create `olle-starters` as real files; `src/starters/templates/*.ts` becomes a build-time-generated snapshot of that repo (the same binary-embed mechanism migrations and the API reference already use), carrying the snapshot's commit sha. `install_starter` stamps `upstream` from the snapshot's provenance. Nothing else changes: first boot still installs a channel starter with zero network — the bootstrap conversation must survive an offline host, so the embedded snapshot is permanent, not transitional.
- **Phase 2 — the update path.** `check_starter_updates` + `merge_starter_upstream` land, plus the pre-stamp fallback (base = local install commit). From here a binary upgrade *and* a network sync both deliver starter fixes; the network path works between binary releases.
- **Phase 3 — third-party repos.** `install_starter(repo: <url>)` for arbitrary git URLs, gated as today (strategic, inbox, smoke). Discovery is conversational at this stage — someone tells you the URL.
- **Phase 4 (deferred) — community index.** A `community-starters.json` in the canonical repo, join-by-PR with CI validation (Obsidian's model). Only worth building when third-party starters actually exist.

## Explicitly deferred

- **Community index / gallery** (Phase 4) — until there are third-party starters to list.
- **Signing or provenance verification of third-party starters** — v0 trust is code review by the agent plus principal approval, the same "friend you handed the code to" bar the mesh uses. Revisit alongside mesh trust hardening.
- **Auto-update policies** ("always take patch releases") — every update is a proposal until ledger evidence shows approval fatigue.
- **npm / ants.land as mirror channels** — no tarball channel until git distribution proves insufficient.
- **A registry server of any kind** — deno.land/x's fate acknowledged; we are ~2 orders of magnitude below the scale where its lessons apply.

## Open questions

1. **Compatibility metadata.** The extension API evolves with the binary. Does a starter version need `minOlleVersion` (Obsidian solves this with a `versions.json` compat map)? Without it, a fresh upstream sync can pull code the host's API can't load — smoke catches it, but only after the merge work is spent.
2. **Changelog surface.** The update proposal needs a human-readable delta. Per-starter `CHANGELOG.md` in the monorepo, or generated from git log between tags? Whichever it is, the proposal-writing agent needs it fetchable before the merge.
3. **Tag drift.** If `ref` resolves to a different sha than a previously-seen tag (force-pushed tag), does `merge_starter_upstream` refuse, or warn-and-record? Leaning warn-and-record with the sha in the proposal — refusal is a lock, and beliefs have inertia, not locks; but this is security-adjacent, so it deserves a real decision.
4. **Name collisions.** `manifest.name` must match the directory; a third-party starter named `telegram` collides with an installed one. Rename-on-install (with `upstream.subdir` preserving the origin name), or namespace directories? Rename-on-install is leaning, but it breaks the name-equals-dir invariant's simplicity.
5. **Secrets drift.** v0.4.0 may require a secret v0.2.0 didn't. The SETUP.md diff should surface in the proposal so approval and secret-collection happen in one conversation — mechanism unspecified.
6. **Snapshot-first vs network-first install.** When online, should `install_starter` prefer upstream-latest over the embedded snapshot? Leaning snapshot-first (deterministic, offline-identical) with an immediate `check_starter_updates` nudge in the result — but that means every fresh install may immediately propose an update, which is noise.
7. **Where divergence is measured.** "Locally modified" = commits touching the subtree since the last sync commit. Renames and `.scratch/` noise make this heuristic fuzzy; the merge tool needs a precise definition before it can report divergence honestly.
