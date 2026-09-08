# Jellyfin Watch branding

The violet-and-cyan jellyfish with a play symbol is the shared identity for the
Discord application, bot, and embedded player. The original PNGs are kept in the
repository so the deployed branding can be reproduced.

| Asset | Path | Dimensions | Use |
| --- | --- | --- | --- |
| Icon | [jellyfin-watch-icon.png](../apps/activity-web/public/branding/jellyfin-watch-icon.png) | 1254 × 1254 | Bot avatar, application icon, player header, favicon |
| Banner | [jellyfin-watch-banner.png](../apps/activity-web/public/branding/jellyfin-watch-banner.png) | 1672 × 941 | Bot profile banner |
| Cover | [jellyfin-watch-cover.png](../apps/activity-web/public/branding/jellyfin-watch-cover.png) | 1254 × 1254 | Application cover |

The banner keeps its mark and type within the middle of the image to accommodate
Discord's wider profile crop. The square icon has padding for circular avatars.
The application cover has its own square composition: the observed app-icons CDN
derivative crops a wide cover to a square, so reusing the banner cuts off its
mascot and title. None of the images contain credentials or private library details.

The player serves these assets from `/branding/` behind the same mandatory
Discord origin gate as its other static files. Discord receives its own uploaded
copies for public application/profile branding.

## Generation record

All assets were created with the built-in image-generation tool on 2026-09-08.
The banner and cover use the completed icon as their visual reference. Originals were
copied into this repository without altering the generated images.

### Icon prompt

> Use case: logo-brand. Create one finished square 1024x1024 app icon for a private Discord Activity named Jellyfin Watch, which plays Jellyfin movies and episodes together. Premium polished 3D mascot icon: one compact translucent jellyfish, with a softly domed violet jelly body, electric cyan rim lighting, and three short gracefully curved cyan tentacles. A crisp luminous white right-pointing play triangle is embedded prominently in the middle of its dome. Deep midnight navy full-bleed background with an extremely subtle indigo halo. Strong simple silhouette, smooth glossy glass-jelly material, elegant restrained lighting, playful but not childish. Single central symbol occupying about 70 percent of the square, generous safe padding for Discord's circular avatar crop, instantly legible at 32 pixels. No text, no letters, no wordmark, no border, no mockup, no additional objects, no watermark. Deliver the standalone finished icon, not a presentation sheet.

### Banner prompt

> Use case: logo-brand. Create one polished wide 16:9 Discord Activity cover / bot profile banner for Jellyfin Watch, ideally 1536x864. The supplied image is the exact brand mascot reference: preserve its translucent violet jellyfish, three short cyan tentacles, and luminous white play triangle. Compose a clean wide brand banner on midnight navy, with a soft atmospheric violet and cyan glow. Put a small, crisp version of this mascot just left of a strong elegant white wordmark reading exactly "JELLYFIN WATCH". Under the wordmark, smaller soft lavender text reads exactly "Movies and episodes, together." The entire mascot-and-text lockup must fit inside the central 40 percent of the image height, with generous empty dark space above and below, so the image also crops cleanly to a very wide Discord bot banner. Keep the mascot and type separated, no overlap, high contrast, simple and premium, generous padding at both sides. No additional symbols, no Discord logo, no border, no watermark, no mockup, no presentation sheet. A single finished banner image.

### Square cover prompt

> Use case: logo-brand. Create one finished SQUARE 1:1 application cover for Jellyfin Watch, ideally 1024x1024. The reference is the exact brand mascot: preserve this translucent violet jellyfish, three short cyan tentacles, and white play triangle. On a midnight navy square with a subtle violet/cyan atmospheric halo, place the mascot centered in the upper-middle area, occupying roughly 40 percent of image height. Below it place a clean strong white wordmark on one centered line reading exactly "JELLYFIN WATCH". Under that, smaller soft lavender text reads exactly "Movies and episodes, together." Keep all important content inside the middle 75 percent of the square, with generous safe padding and clear separation between mascot and text. Premium glossy 3D jelly mascot, restrained glow, highly readable typography, balanced square app-cover composition. No additional symbols, no border, no mockup, no watermark. Return only the single square finished cover.
