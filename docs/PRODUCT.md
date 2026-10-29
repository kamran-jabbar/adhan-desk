# Product scope

Adhan Desk is a small, free, open-source desktop app for people who keep a computer running and want the complete adhan at their own mosque's published prayer times. Setup should take only a few choices: confirm a mosque, test the included recording and select the wanted prayers.

## Current product

| Need | Behavior |
| --- | --- |
| Follow a mosque | Configurable public MAWAQIT URL; Hervanta preset |
| Hear the full adhan immediately | Included, unchanged CC BY-SA 4.0 recording, approximately 87 seconds |
| Use another recording | Full local audio import or configurable embeddable YouTube video |
| Stay available | Closing the window keeps the tray app running; packaged first launch enables login startup |
| Control playback | Five prayer switches, volume, pause and stop |
| Understand status | Next prayer, source/refresh state and recent activity log |
| Handle short network outages | Up to seven saved dated days and local audio |
| Avoid repeated calls | Persistent prayer attempts; 90-second late-playback window |
| Reach desktop users | Windows x64, macOS x64/arm64 and Linux x64 build workflow |

A fresh installation enables automatic playback using the bundled recording. The app preserves existing user preferences. Keep-awake is optional. No account, cloud application backend or audio download is required for the included sound.

Windows is the primary exercised platform. Installation, login startup, playback and scheduling have been checked there. macOS and Linux remain build targets that require manual installation, speaker, tray and startup verification. Each release needs a new packaged-app smoke check after significant changes.

## Reliability boundaries

The computer must be on, awake and logged in, with the app running and an audible output. The app cannot play after shutdown, bypass mute, restore unplugged speakers or keep running after logout. Login startup restores it after login. Keep-awake requests help prevent idle suspension while enabled.

The mosque's five published adhan times remain authoritative. Sunrise, Jumua and iqama do not add automatic calls. Source failures leave only already saved dates usable. Retry intervals grow from 1 to 2, 4, 8 and 15 minutes, then stay at 15 minutes. The cache is never extended beyond its dates or reused across a year boundary. Special Sabah/Imsak calendars require explicit support before acceptance.

A full recording plays until it ends or the user stops it. The same voice is used for all prayers in this version. YouTube availability depends on the provider and uploader; local audio keeps automatic playback independent of those restrictions. Failed playback is visible and does not create repeated automatic attempts.

## Priorities

1. Verify macOS and Linux on real machines, and broaden Windows checks for resume, locked-screen audio, timezone changes, output changes and network failures.
2. Add signed installers, macOS notarization and a tested update path.
3. Add separate Fajr audio, clearer audio-output feedback and accessible setup improvements.
4. Seek a documented, permitted MAWAQIT integration; maintain public-page adapter tests until then.
5. Add language support, mosque discovery and carefully verified special timetable formats.
6. Extend the recording library only with clear redistribution rights and preserved attribution.

Multiple household devices and managed mosque displays would need explicit device ownership and duplicate-playback rules. They should follow a dependable single-computer experience.

## Mobile

A future Android or iOS client can share timetable contracts and product choices. Its background scheduling and full-length audio require a separate native implementation and real-device verification under each mobile operating system's restrictions. Desktop packaging does not establish mobile support.

## Ownership

The application source is MIT licensed. The included recording remains CC BY-SA 4.0; its [attribution and integrity details](AUDIO-LICENSE.md) ship with it. Personal imported recordings are outside the public source. The project is independent of MAWAQIT, mosques and the recording's creator.
