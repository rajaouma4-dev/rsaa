# Chat design and wallpapers — 4 November 2026

Version 1.0.7, code 8. Chat header/composer use native line icons, restrained purple accents and larger text. Call cards, voice bubbles, photo tray and voice review use coordinated colors. Audio/video actions retain their existing handlers and call recovery.

The conversation overflow menu opens Background and Bubble color tabs with a live sample. Users can select solid, gradient or glow effects, six presets or a validated hex color. Bright bubble colors automatically get dark message text. Save persists per-conversation appearance on this device; close discards the draft. Preferences are not synchronized to the recipient.

Four supplied JPEGs were resized/compressed and upserted to the existing authorized Turso database in `chat_theme_assets`: Botanical (36,635 bytes), Moon cat (31,042), Mountain (37,665), Contour (33,111). Records have stable IDs, SHA-256 versions and JPEG data URIs. The reusable seed script reads backend-only credentials and contains no tokens. Images stay below signaling frame size limits. Authenticated clients fetch catalog metadata and individual assets through existing signaling; there is no database credential in the app.

First chat open loads/caches wallpapers automatically, with Botanical as default. Images use cover sizing without stretching and a subdued opacity for readability. Metadata is checked at most daily; unchanged asset versions reuse persistent AsyncStorage cache. Concurrent loads share one request chain. Previously cached assets remain usable offline. Each chat remembers its chosen wallpaper/color/effect.

Checks: TypeScript typecheck, 19 Rust tests (2 opt-in tests skipped), 31-statement SQL migration regression, wallpaper cache/preferences/contrast test and call/session regressions passed. Final APK build and v2 signature passed with the existing test signer; the incremental packaging attempt failed once and succeeded on retry. Final APK installed on three existing emulators with data retained.

Live server `4eff1cc` was verified. On C, the menu loaded all four database wallpapers. Selecting Moon cat and blue gradient updated preview and saved to the actual conversation. A synthetic text message reached B. After force-stop/relaunch, the wallpaper persisted and custom color field restored `#1669D8`. No new camera/audio quality certification is claimed by this UI-only work.

Universal test APK SHA-256: `e04b59d5dafa1f4b240c8216bc96cd953de77f06a29c6e5668bad5403bfa4e37` (143,599,626 bytes).
Screenshots: `docs/chat-ui-v107.png`, `docs/chat-appearance-v107.png`.
