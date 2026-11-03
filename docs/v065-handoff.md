# 0.6.5 implementation handoff

Updated: 2026-11-03. Branch: `local/hardened`.

## Completed

- `3f52459`: Local `[HH:MM:SS]` timestamps in chat and panel history; retain 500 lines.
- `6675bc6`: League ping sentences in chat history, including own pings, excluding generic pings and emotes.
- `1cbae54`: Remembered category filters shared by chat and panel history. Filter controls live only in panel history, as requested later.
- `c3e910e`: Reproducible extraction of eleven original spell icons and sounds.
- `2e0ef68`: Pure cooldown logic, including two sequential Smite charges and a 15-second cast gap.
- This commit: Windows summoner settings, defaults and normalization; shared League-style picker; swapping D/F when choosing the other slot's spell; localization and tests.

The standalone Summoner spells section sits below Emotes, with its own default-off switch, D/F choices and local sound switch. Its options remain visible but inert and grey while off. Rooms must be enabled; the room panel feature is not required. D defaults to Heal, F to Flash. There is no separate summoner switch in the Rooms expander or sound row in the Sound section.

The settings UI is ready. Actual casting, room synchronization, panel display and sound playback are not wired yet.

## Next work, in order

1. Windows native input monitoring and main-process casting.
   - Observe bare D/F without swallowing or reordering keys, including while typing.
   - Only act while lolPing is enabled, in a room and the spell feature is on.
   - Respect the existing fullscreen gate when `gameCheck` is enabled.
   - Wire the helper event to the shared cooldown module. Add pass-through and gating tests.
   - Keep macOS/Linux input behavior unchanged; they will still display and click peer spells.
2. Room synchronization and reset behavior.
   - Extend presence with spell IDs and cooldown end times, validating untrusted input.
   - Keep old peers compatible. Existing peers should ignore added presence fields; verify this before deciding whether a protocol bump is needed.
   - Add a spell-click message that old peers can ignore.
   - Reset local cooldowns on leave, feature off, spell change and restart.
3. Room panel and scoreboard chat lines.
   - Put two icons beside every member, with a JS clock sweep and remaining time; show Smite charges.
   - Members without spell data use ready D Heal / F Flash.
   - Left click posts the agreed League sentence in the scoreboard category, respecting the shared filter.
   - Right click on an own icon clears its cooldown. Casting itself must not post chat.
4. Local cast sound and final verification.
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

For the settings/picker commit in this session:

- TypeScript check passed using `node --single-threaded --max-old-space-size=1024 node_modules/typescript/bin/tsc --noEmit`.
- `npm test -- --maxWorkers=1 --pool=threads`: 143 files passed; 2227 tests passed, 11 skipped.
- `npm run test:helper`: 699 helper tests and 533 context tests passed.
- Windows development app inspected: section order, shared menu, D/F swapping and grey/inert controls while off.

## Local development notes

- The development app was left open on the summoner section with its feature switched off. No push or release was requested.
- Real npm is `C:/nvm4w/nodejs/npm.cmd`; npm/test subprocesses may need the existing sandbox escalation.
- Use one Vitest worker with the threads pool to avoid local process/memory issues.
- Close the development app before rebuilding native helpers, since the helper executable is locked while running.
- Start development with `C:/nvm4w/nodejs/node.exe node_modules/electron-vite/bin/electron-vite.js dev --inspect 9339`.
- Main/preload changes require restart. Renderer HMR may miss rapid writes; verify the loaded version.
- Do not stop an installed app belonging to the user. Only stop the development process owned by this task.
