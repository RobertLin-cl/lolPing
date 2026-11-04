# 0.6.5 implementation handoff

Updated: 2026-11-04. Branch: `local/hardened`.

## Completed

- `3f52459`: Local `[HH:MM:SS]` timestamps in chat and panel history; retain 500 lines.
- `6675bc6`: League ping sentences in chat history, including own pings, excluding generic pings and emotes.
- `1cbae54`: Remembered category filters shared by chat and panel history. Filter controls live only in panel history, as requested later.
- `c3e910e`: Reproducible extraction of eleven original spell icons and sounds.
- `2e0ef68`: Pure cooldown logic, including two sequential Smite charges and a 15-second cast gap.
- `06b6534`: Panel spell icons, cooldown animation, charge display, scoreboard reports and own-slot clear.
- `2293168`: Validated optional spell presence, delayed-packet protection and compatible spell-click transport.
- `f7e451a`: Windows passive D/F input and local cooldown session, including room/fullscreen gates and resets.
- `5ab0f8a`: Windows summoner settings, defaults and normalization; shared League-style picker; swapping D/F when choosing the other slot's spell; localization and tests.

The standalone Summoner spells section sits below Emotes, with its own default-off switch, D/F choices and local sound switch. Its options remain visible but inert and grey while off. Rooms must be enabled; the room panel feature is not required. D defaults to Heal, F to Flash. There is no separate summoner switch in the Rooms expander or sound row in the Sound section.

The 0.6.5 implementation is complete in code. The sound segment committed with this handoff adds own-cast sound through one
existing overlay SoundBank, with live volume, global mute and the summoner sound switch. Peer presence, reports
and clears never play cast sound. The room protocol stays at version 1 and the app version has not been changed.

## Next work, in order

1. Remaining manual acceptance checks.
   - Foreground fullscreen application: with gameCheck on, bare D/F must still type/pass through but not cast; with it off, casting resumes. Native automated tests pass, but no live fullscreen takeover was done while the user was operating the app.
   - macOS/Linux real-app inspection of peer icons and clicks is still needed on those operating systems. Local D/F casting remains Windows-only and platform tests pass.
   - User listening feedback on actual sound quality is still useful; real Web Audio decoding, playback source creation and gain were verified, but the agent does not hear the speakers.
2. Commit, push and release only when the maintainer asks. The sound segment is committed with this handoff. Do not bump the package version or change release workflows on your own.

The original agreed requirements and game sentence keys are in the earlier handoff and `v065-requirements.md` under the user's Claude project memory. The later UI and filter decisions above supersede their original placement instructions.

## Assets and tools

- All eleven PNG/WAV pairs are already under `assets/summoners`.
- Extraction code and mappings are under `tools/extract-assets`.
- User-approved Python, vgmstream, ManifestDownloader and the Riot Common WAD are already in the ignored extraction cache. Do not download them again without a concrete need.
- The extracted assets have already been decoded and inspected. No app-time asset download is needed.

## Last verification

For the committed local-casting segment (`f7e451a`):

- TypeScript check passed using `node --single-threaded --max-old-space-size=1024 node_modules/typescript/bin/tsc --noEmit`.
- `npm test -- --maxWorkers=1 --pool=threads`: 144 files passed; 2235 tests passed, 11 skipped.
- `npm run test:helper`: 742 helper tests and 533 context tests passed.
- Windows development app verified with real D/F key presses in a temporary local text field. Characters reached the field, both slots updated real main-process cooldown state, and a second D did not restart Heal's cooldown.
- Shift+D produced text without casting. Gesture suspension still allowed passive events. Feature off cleared cooldowns and stopped events; pausing stopped events while F still typed. Settings were restored and all temporary instrumentation removed.
- Fullscreen gating, held-key repeats, custom-trigger typing order, platform support, and keys held during feature enabling are covered by native tests. A live fullscreen app has not been checked in this segment.
- The first concurrent run hit native linker memory exhaustion and test-agent process failures. Sequential native compilation and a fresh full test run both passed.

For the committed synchronization segment (`2293168`):

- TypeScript and 742 helper / 533 context tests passed.
- Focused protocol, validation, room manager and local session tests: 238 passed.
- Two real signed RoomManagers on isolated UDP loopback ports passed ready-state sync, a Flash cast, feature-off reset and leave. No public relay or user room was used for this smoke test.
- The actual decoder from `f7e451a` accepted the new presence and ignored the new spell-click message.
- Windows development app: real D typed normally and updated the room state with Heal's cooldown. Feature off removed the room's spell state. Temporary fields were removed and preferences restored.
- Full regression passed with 145 files, 2249 tests passed and 11 skipped using Node 24.22.1 with `--maxWorkers=1 --pool=forks` and a 768 MB heap. Thread workers twice failed to clone their result with an out-of-memory error despite free system memory.

For the committed panel segment (`06b6534`):

- TypeScript passed; 742 helper and 533 context tests passed.
- Full regression: 147 files passed; 2259 tests passed and 11 skipped, using Node 24.22.1, one worker and the forks pool.
- Focused panel animation, IPC, formatting, filtering, session clear and text tests passed (66 tests).
- Real Windows panel inspected through an isolated harness using production PanelWindows, renderer, RoomHistory, SummonerSession and startRoomText. No test message was sent to the user's room.
- Verified both spell slots, live countdowns, own-slot right-click clear, Smite charges, old-peer ready fallback, long-name ellipsis, green history lines and Scoreboard filtering. Filtered spell lines stayed in history.
- The isolated panel and event listeners were destroyed after QA. The normal development app remains open; no user preferences were changed by this panel QA.
- Next: local cast sound, then final two-peer interaction checks and fullscreen/input checks before release. Actual cross-platform UI inspection still requires those operating systems.

For the sound/final integration segment committed with this handoff:

- Typecheck passed; native tests: 742 helper and 533 context tests passed.
- Full regression: 148 files passed, 2262 tests passed, 11 skipped (one worker, forks pool, Node 24.22.1).
- Desktop production build and browser demo build passed; all eleven summoner WAVs survived the desktop asset build.
- Focused sound-buffer/gain, overlay routing, settings, IPC and local session tests: 184 passed.
- Each of two real overlay renderers decoded all eleven spell WAVs. Actual user casts produced Flash and Heal AudioBufferSource playback only on one overlay; the second overlay stayed silent. PCM peaks were nonzero, AudioContext was running, and gain followed the user's change from volume 5 to 3.
- A hidden, audio-muted renderer using production preload and overlay code verified enabled playback, global mute, separate spell sound off, volume zero and re-enable behavior through actual IPC and Web Audio. It was destroyed afterwards.
- Two real signed loopback peers passed localized spell reports, hidden-but-recorded Scoreboard filtering, slot clear, feature reset and leave. The previous decoder still accepted new presence and ignored spell-click packets.
- The user was actively testing the development app, so automated input stopped and no fullscreen switch was forced. The temporary input field and all audio/main debugger instrumentation were removed; the user's volume 3 and other live settings were preserved.

## Local development notes

- The development app was left open on the summoner section. The spell feature and lolPing enabled state were restored to their pre-test values (both on). The sound segment is committed with this handoff; no push or release was requested.
- Real npm is `C:/nvm4w/nodejs/npm.cmd`; npm/test subprocesses may need the existing sandbox escalation.
- Use one Vitest worker with the threads pool to avoid local process/memory issues.
- Close the development app before rebuilding native helpers, since the helper executable is locked while running.
- Start development with `C:/nvm4w/nodejs/node.exe node_modules/electron-vite/bin/electron-vite.js dev --inspect 9339`.
- Main/preload changes require restart. Renderer HMR may miss rapid writes; verify the loaded version.
- Do not stop an installed app belonging to the user. Only stop the development process owned by this task.
