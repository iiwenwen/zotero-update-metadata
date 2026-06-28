# Logo Generation

## Source

- Generator: Codex built-in image generation
- Date: 2026-06-28
- Issue: CNB #49
- Final transparent source: `doc/assets/logo-codex-source.png`
- Plugin icons:
  - `addon/content/icons/favicon.png` (64x64)
  - `addon/content/icons/favicon@0.5x.png` (32x32)

## Prompt

```text
Use case: logo-brand
Asset type: Zotero desktop plugin logo/icon, final source for 64px and 32px app icons
Primary request: Create a refined, professional logo mark for a Zotero plugin named "Update Metadata". Communicate refreshing bibliographic metadata with a simple open book/document-card silhouette and one circular refresh arrow. No text, no letters, no UI screenshots.
Style/medium: flat vector-like app icon, elegant, minimal, crisp geometric shapes, high readability at 32px, no glossy 3D, no gradients, no shadows.
Composition/framing: centered mark on a square canvas, generous padding, bold simple shapes, not crowded, fewer elements than a typical illustration.
Color palette: restrained and premium: deep charcoal #20242a for the refresh arrow and outline, warm paper white #f7f4ec for the book pages, one small muted Zotero red accent #c7302b only as a bookmark or one metadata line. No teal, no blue, no saturated green in the subject.
Scene/backdrop: perfectly flat solid #00ff00 chroma-key background for background removal.
Constraints: background must be one uniform #00ff00 color with no shadows, gradients, texture, floor plane, reflections, or lighting variation. Keep the subject fully separated from the background with crisp edges and generous padding. Do not use #00ff00 anywhere in the subject. Avoid bright candy colors. Avoid teal/blue accents. Avoid thick white outer glow. No cast shadow, no reflection, no watermark, no text.
```

## Processing

The generated chroma-key image was copied from Codex's generated image cache, converted to transparent PNG with the system `imagegen` chroma-key helper, then downscaled to the two plugin icon sizes referenced by `addon/manifest.json` and runtime UI code.
