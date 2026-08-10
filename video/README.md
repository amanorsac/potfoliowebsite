# Video

Drop video files in this folder and tell me where on the site they should
go. Same idea as the `audio` folder next to it.

## Before you upload: the size ceiling

Cloudflare will not serve a single file larger than **25 MB**. That is not
a setting we can change — it is the limit on how this site is hosted.
GitHub also starts complaining at 50 MB and refuses outright at 100 MB.

25 MB is roughly **30 to 60 seconds** of good-looking 1080p, or two to
three minutes if the picture is simpler and we compress harder.

So:

- **Short clips** — a few seconds of hands on keys, a room tone shot, a
  before-and-after — belong here. Upload the original and I will
  compress it; phone footage is usually five to ten times larger than it
  needs to be.
- **Anything longer** — a full performance, a session walkthrough, a
  tutorial — should go on YouTube, and the site embeds it. That is
  already how the "On record" player works. YouTube also handles the
  things a file cannot: it drops to a lower quality on a bad connection
  instead of stalling, and it does not cost you bandwidth.

If you are not sure which a particular video is, send it and I will tell
you.

## Naming

Lower case, hyphens, no spaces. Say what it is:

    keys-close-up.mp4
    desk-pan.mp4
    before-after-vocal.mp4

## What I do with them

Convert to MP4 (H.264) and usually a WebM as well, compress to something
sensible, strip the audio track if the clip is silent decoration, and
generate a still frame to show before it plays — so the page is not blank
while the video loads.

Then I add it to whichever page you want, muted and looping if it is
decoration, with proper controls if it is something to watch.
