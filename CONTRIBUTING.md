# Contributing to Adhan Desk

Use the [bug report form](https://github.com/kamran-jabbar/adhan-desk/issues/new?template=bug_report.yml) for reproducible problems. Include the app and OS versions, playback mode, steps, and relevant Activity messages. Timing reports should include the public mosque URL, date, prayer, expected and actual times, and both timezones. Remove private paths and personal information before posting.

For security reports, follow [SECURITY.md](SECURITY.md).

## Development

Install Node.js 24 and pnpm 11.25.0, then run:

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm start
```

Build an installer on the matching operating system with `pnpm build:win`, `pnpm build:mac`, or `pnpm build:linux`. The workflow builds macOS Intel and Apple Silicon packages. Linux and Windows release packages target x64.

Keep changes focused and explain the problem, resulting behavior, and validation in your pull request. Add meaningful regression tests for scheduler, timetable parsing, or local server changes. Use the mosque's timezone and published prayer times; do not silently replace missing data with calculated times. Keep sunrise and iqama separate from the five daily adhan triggers.

When testing audio, use a silent fixture or mute the test application. Manually check full recording completion, tray behavior, and login startup on the affected OS. CI tests and successful packaging do not verify audible output or desktop behavior on a physical machine.

Only contribute recordings and other assets that may be redistributed, with their license and attribution. Never commit personal recordings, application profiles, credentials, `node_modules`, or installer output.

## Releases

A successful push to `main` publishes a prerelease for the version in `package.json` after every platform build passes. Pull requests and manual workflow runs build artifacts without publishing. Existing releases and tags are preserved; bump the version for another release. Preview packages are unsigned and macOS packages are not notarized.
