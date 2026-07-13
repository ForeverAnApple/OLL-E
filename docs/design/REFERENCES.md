# OLL-E — References

Prior art we studied, and what we took or left from each. One entry per project. The format: what it is, what we took, what we left, and why. Entries are evidence for decisions in `LOG.md` — cite the entry, not the project's marketing page.

---

## pi-mono (Pi agent harness) — `references/pi-mono/`

Earendil's self-extensible coding agent: a TypeScript monorepo whose CLI (`@earendil-works/pi-coding-agent`) hosts hot-reloadable extensions, skills, prompt templates, and themes — and whose distribution story is the closest prior art to what OLL-E's starters need.

**The pattern** (`packages/coding-agent/docs/packages.md`, `src/core/package-manager.ts`): a "pi package" is a plain npm package *or* git repo *or* local path. A `pi` key in `package.json` declares resource globs; absent that, conventional directories (`extensions/`, `skills/`, `prompts/`, `themes/`) are auto-discovered. `pi install npm:@foo/bar@1.0.0` / `pi install git:github.com/user/repo@v1` records the source string in a settings JSON (user or project scope); versioning is pinned npm versions or pinned git refs; `pi update --extensions` reconciles clones to the configured ref but never silently moves a pin — moving a pin is an explicit re-install with a new ref. Installed git packages are kept **pristine**: reconcile is `git reset --hard` + `git clean -fdx` (`ensureGitRef`, package-manager.ts:1821). Local modification lives elsewhere — auto-discovered `~/.pi/agent/extensions/` and `.pi/extensions/` dirs, or a local-path package. Discovery is registry-less: npm *is* the registry; the `pi-package` keyword drives the pi.dev/packages gallery (5,000+ packages, download counts, type badges) with zero submission process.

**Took:**
- **Source strings as the whole install grammar** — `git:host/user/repo@ref`, no registry server, no package format beyond "a repo shaped the conventional way." The repo is the package; the ref is the version.
- **Pins never move implicitly** — update reconciles to the recorded ref; adopting a newer upstream is an explicit act that rewrites the record.
- **Registry-less community sharing** — discovery rides existing infrastructure (for pi, an npm keyword; for us, a git repo with an index file) rather than a service we'd have to run.
- **The editorial doc pattern** (already adopted, LOG 2026-07-10): complete quick-start artifact first, types as inline comments in runnable snippets, footgun pairs.
- **Staleness-poisoning on unload** (already adopted, LOG 2026-07-11): revoked extension handles throw instead of acting as a dead registration.

**Left:**
- **Pristine installs.** Pi's answer to "installed but modified" is *don't* — fork the repo or copy to a local dir. OLL-E's whole premise is that agents clone starters *and modify them in place*; our update path must be a three-way merge into a locally-diverged copy, which pi deliberately refuses to support.
- **npm as a distribution channel.** Extensions in OLL-E are Bun-only, no third-party deps (decision-inbox escape hatch aside); `npm install` inside `~/.olle/extensions/` would import the entire node_modules supply chain into the agent-writable surface. Git only.
- **Settings JSON as the install record.** Our record of provenance belongs in the extension's own `manifest.json` (the visible authority boundary) and the extensions git history, not a separate config file.
- **The separate global/project scope split** — one host, one extensions dir, one sovereignty boundary; scope is OLL-E's agent/team model, not a directory hierarchy.

See `docs/design/STARTER-DISTRIBUTION.md` for the design this informed.
