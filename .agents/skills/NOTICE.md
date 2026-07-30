# Third-party skills

The skill folders in this directory are vendored, not written for this project.
Two separate upstream sources, both MIT licensed.

## 1. Skills for Design Engineers

- **Source:** https://github.com/emilkowalski/skills
- **Author:** Emil Kowalski
- **Licence:** MIT — see `LICENSE`
- **Installed with:** `npx skills@latest add emilkowalski/skills`
- **Pinned by:** `skills-lock.json` in the repository root
- **Skills:** animation-vocabulary, apple-design, emil-design-eng,
  find-animation-opportunities, improve-animations, pick-ui-library,
  prototype, review-animations

## 2. taste-skill

- **Source:** https://github.com/Leonxlnx/taste-skill
- **Author:** Leonxlnx
- **Licence:** MIT — see `LICENSE-taste-skill`
- **Installed by:** copying the upstream `skills/` directory (the repo is
  packaged as a Claude Code plugin; only the skill definitions are vendored.
  The upstream `assets/`, `examples/`, `research/` and `scripts/` directories
  are **not** included — nothing in the skills references them.)
- **Skills:** brandkit, brutalist-skill, gpt-tasteskill, image-to-code-skill,
  imagegen-frontend-mobile, imagegen-frontend-web, minimalist-skill,
  output-skill, redesign-skill, soft-skill, stitch-skill, taste-skill,
  taste-skill-v1
- `taste-skill-llms.txt` is the upstream index of that library.

To update either set, re-run its install method above.

## Layout

`.claude/skills/*` are symlinks into this directory, which is how Claude Code
discovers them. Other agent tools read `.agents/skills` directly.

These files are development tooling. They are not part of the website and
should never be served to visitors.
