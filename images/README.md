# Screenshots

Real captures of the HarmonieMD interface. The UI is exactly what ships; the content (song titles, member names, ratings, cover art) is seeded demo data chosen to be representative.

> **Never caption these as real customer data.** Using representative content in product screenshots is standard practice, but presenting it as genuine usage would not be.

`raw/` holds the originals at full window size. The files at this level are the working copies — crop and composite these.

## Index

| File | Size | Priority | Use | Caption |
|---|---|---|---|---|
| `01-explore-guest.png` | 1424×892 | **P0** | Explore section, secondary hero | *Start listening before you sign up.* |
| `02-setlists.png` | 1424×892 | P2 | Feature strip | *Every service, organised.* |
| `03-setlist-detail.png` | 1424×892 | P1 | Setlist feature | *Sunday, organised.* |
| `04-md-editor.png` | 1584×972 | **P0** | **Primary hero** | *A real multi-track studio that understands choirs.* |
| `05-choir-mode.png` | 1424×972 | **P0** | **Primary singer-facing** | *Your part. Your mix. As many times as you need.* |
| `06-library.png` | 1424×892 | P1 | Library feature | *Your team's permanent catalogue.* |
| `07-team-plans.png` | 1424×892 | P2 | Pricing section | *Grows with your team.* |
| `08-profile.png` | 1424×892 | P3 | Detail collage | *Your profile.* |
| `09-explore-player.png` | 1424×972 | P1 | Explore feature | *Every arrangement, playable by anyone.* |
| `10-notices.png` | 1424×892 | P3 | Detail collage | *Everyone sees the same message.* |

## Still to capture

| Shot | Priority | Why it matters |
|---|---|---|
| Calibration in progress | **P0** | Sells the key differentiator |
| Calibration success ("Measured 92ms — excellent") | **P0** | The payoff moment |
| Take stack inspector (Take 1 / Take 2) | P1 | Sells non-destructive comping |
| Drag-and-drop upload (file over a lane) | P2 | Sells ease of use |
| Explore at 375px | P2 | Responsive proof |
| Empty library state | P3 | Honest onboarding story |

These need UI interaction (opening panels, selecting clips), which the automated capture script can't drive. Capture them manually — see `../tools/README.md`.

## Presentation guidance

The product is dark. On a light page, a raw dark screenshot dies. Always:

- Place on a near-black `#0a0e17` surface
- Add an indigo radial bloom behind the device — `rgba(109,124,255,.25)`
- Use a deep shadow: `0 40px 120px rgba(0,0,0,.6)`
- Composite into a device mockup rather than showing a bare rectangle

**Crop hint for `04-md-editor.png`:** the track lanes end around y=660; the remaining space below is empty. Crop to roughly the top 70% for a tighter, denser hero image.

**Mobile:** don't scale the MD editor down — it becomes unreadable. Crop to a detail (two or three lanes) instead.

## Alt text

Written and ready to copy in [`../json/product.json`](../json/product.json) under `screenshots[].alt`.
