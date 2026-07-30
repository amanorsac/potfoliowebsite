# Third-party skills

The skill folders in this directory are vendored, not written for this project.

- **Source:** https://github.com/emilkowalski/skills
- **Author:** Emil Kowalski
- **Licence:** MIT — see `LICENSE` in this directory
- **Installed with:** `npx skills@latest add emilkowalski/skills`
- **Pinned by:** `skills-lock.json` in the repository root (records the source
  and a content hash for each skill)

`.claude/skills/*` are symlinks pointing here, which is how Claude Code
discovers them. The same content is read directly from `.agents/skills` by
other agent tools.

To update them, re-run the install command above; it rewrites the lock file.

These files are development tooling. They are not part of the website and
should never be served to visitors.
