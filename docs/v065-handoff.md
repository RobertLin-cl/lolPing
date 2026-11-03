# 0.6.5 implementation handoff

Updated: 2026-11-03. Branch: `local/hardened`.

## Completed

- `3f52459`: Local `[HH:MM:SS]` timestamps in chat and panel history; retain 500 lines.
- `6675bc6`: League ping sentences in chat history, including own pings, excluding generic pings and emotes.
- `1cbae54`: Remembered category filters shared by chat and panel history. Filter controls live only in panel history, as requested later.
- `c3e910e`: Reproducible extraction of eleven original spell icons and sounds.
- `2e0ef68`: Pure cooldown logic, including two sequential Smite charges and a 15-second cast gap.
- `5ab0f8a`: Windows summoner settings, defaults and normalization; shared League-style picker; swapping D/F when choosing the other slot's spell; localization and tests.

The standalone Summoner spells section sits below Emotes, with its own default-off switch, D/F choices and local sound switch. Its options remain visible but inert and grey while off. Rooms must be enabled; the room panel feature is not required. D defaults to Heal, F to Flash. There is no separate summoner switch in the Rooms expander or sound row in the Sound section.

The settings UI and Windows local casting are ready. The current uncommitted segment adds passive D/F observation,
helper protocol version 8, platform and room gates, and an in-memory local cooldown session. Room synchronization,
panel display and sound playback are not wired yet. Casting currently has no visible or audible feedback.

## Next work, in order

1. Room synchronization and reset behavior.
   - Extend presence with spell IDs and cooldown end times, validating untrusted input.
   - Keep old peers compatible. Existing peers should ignore added presence fields; verify this before deciding whether a protocol bump is needed.
   - Add a spell-click message that old peers can ignore.
   - Local resets on leave, feature off, room change, spell change and restart are already wired; add the corresponding presence updates.
2. Room panel and scoreboard chat lines.
   - Put two icons beside every member, with a JS clock sweep and remaining time; show Smite charges.
   - Members without spell data use ready D Heal / F Flash.
   - Left click posts the agreed League sentence in the scoreboard category, respecting the shared filter.
   - Right click on an own icon clears its cooldown. Casting itself must not post chat.
3. Local cast sound and final verification.
   - Play only the caster's own spell sound, respecting volume, global mute and the summoner sound switch.
   - Update both READMEs and design notes, including input monitoring and peer visibility in privacy notes.
   - Test two peers, old-peer fallback, reset paths, fullscreen gating, keyboard pass-through and actual sound.
   - Run required checks and inspect the real app for each segment. Only release 0.6.5 after all work is complete and the maintainer asks.

The original agreed requirements and game sentence keys are in the earlier handoff and `v065-requirements.md` under the user's Claude project memory. The later UI and filter decisions above supersede their original placement instructions.

## Assets and tools

- All eleven PNG/WAV pairs are already under `assets/summoners`.
- Extraction code and mappings are under `tools/extract-assets`.
- User-approved Python, vgmstream, ManifestDownloader and the Riot Common WAD are already in the ignored extraction cache. Do not download them again without a concrete need.
- The extracted assets have already been decoded and inspected. No app-time asset download is needed.

## Last verification

For the current local-casting segment:

- TypeScript check passed using `node --single-threaded --max-old-space-size=1024 node_modules/typescript/bin/tsc --noEmit`.
- `npm test -- --maxWorkers=1 --pool=threads`: 144 files passed; 2235 tests passed, 11 skipped.
- `npm run test:helper`: 742 helper tests and 533 context tests passed.
- Windows development app verified with real D/F key presses in a temporary local text field. Characters reached the field, both slots updated real main-process cooldown state, and a second D did not restart Heal's cooldown.
- Shift+D produced text without casting. Gesture suspension still allowed passive events. Feature off cleared cooldowns and stopped events; pausing stopped events while F still typed. Settings were restored and all temporary instrumentation removed.
- Fullscreen gating, held-key repeats, custom-trigger typing order, platform support, and keys held during feature enabling are covered by native tests. A live fullscreen app has not been checked in this segment.
- The first concurrent run hit native linker memory exhaustion and test-agent process failures. Sequential native compilation and a fresh full test run both passed.

## Local development notes

- The development app was left open on the summoner section. The spell feature and lolPing enabled state were restored to their pre-test values (both on). The current segment has not been committed; no push or release was requested.
- Real npm is `C:/nvm4w/nodejs/npm.cmd`; npm/test subprocesses may need the existing sandbox escalation.
- Use one Vitest worker with the threads pool to avoid local process/memory issues.
- Close the development app before rebuilding native helpers, since the helper executable is locked while running.
- Start development with `C:/nvm4w/nodejs/node.exe node_modules/electron-vite/bin/electron-vite.js dev --inspect 9339`.
- Main/preload changes require restart. Renderer HMR may miss rapid writes; verify the loaded version.
- Do not stop an installed app belonging to the user. Only stop the development process owned by this task.
