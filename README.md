# PharmaTRACK

A desktop study companion for pharmacy students. Cross-platform Tauri v2 app
built with React, TypeScript and Tailwind CSS.

![Version](https://img.shields.io/badge/version-1.1.82-blue)
![Tauri](https://img.shields.io/badge/Tauri-v2-24C8D8)
![React](https://img.shields.io/badge/React-18-61DAFB)

## Features

- **Courses & topics** — organise your curriculum
- **Slide reader** — PDF/DOCX study materials with progress tracking
- **Quiz engine** — practice questions with history and analytics
- **Study planner & timetable** — classes, quizzes and exams
- **Offline-first** — works fully with no account and no internet
- **Optional cloud sync** — sign in to back up and restore elsewhere
- **Auto-updater** — ships through GitHub Releases

## Offline-first model

This is the core design decision, so it's worth stating plainly:

- **Local storage is the source of truth.** Everything saves to `localStorage`
  and IndexedDB first, always — account or not.
- **An account is optional.** New users go through onboarding (name, level,
  program), never a login wall.
- **Signing in only adds cloud backup.** The four cloud-only actions ask for
  sign-in at the point of use via `src/utils/requireAuth.ts`.
- **Signing out keeps your data.** It ends the cloud session, nothing more.
  Settings → "Clear ALL Data" is the only deliberate wipe.

## Tech stack

| Layer | Tech |
|-------|------|
| Frontend | React 18 + Vite + Tailwind CSS v4 |
| Desktop shell | Tauri v2 (Rust) |
| State | React Context + `useReducer` (`src/context/AppContext.tsx`) |
| Auth & sync | Supabase |
| Local storage | `localStorage` + IndexedDB (`idb-keyval`) |
| Charts | Recharts |
| Tests | Vitest + Testing Library + jsdom |

## Prerequisites

- [Node.js](https://nodejs.org/) 20+
- [Rust](https://rustup.rs/) stable toolchain
- **Linux:** `libwebkit2gtk-4.1-dev libsoup-3.0-dev build-essential curl wget
  file libssl-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev`
- **Windows:** MSVC Build Tools

> **Linux note:** if VS Code is installed as a snap, its injected
> `LD_LIBRARY_PATH` breaks the Rust link step. Use the `.deb` build of VS Code
> or run Tauri commands from a normal terminal. `npm run tauri:dev` already
> clears the variable defensively.

## Development

```bash
git clone https://github.com/g2code33/pharmaTRACK_PERFECT_new.git
cd pharmaTRACK_PERFECT_new
npm install --legacy-peer-deps

# .env in the project root (never commit this):
#   VITE_SUPABASE_URL=your_supabase_url
#   VITE_SUPABASE_ANON_KEY=your_supabase_anon_key

npm run tauri:dev
```

## Commands

| Command | What it does |
|---------|--------------|
| `npm run tauri:dev` | Run the desktop app in dev mode |
| `npm run tauri:build` | Build production installers |
| `npm test` | Run the test suite |
| `npm run test:watch` | Tests in watch mode |
| `npm run version:check` | Verify the version matches in all 5 files |
| `npm run version:set 1.1.83` | Set the version everywhere at once |

## Releasing

The version lives in **five** places (`package.json`, `src-tauri/tauri.conf.json`,
`Cargo.toml`, `Cargo.lock`, and a fallback in `Layout.tsx`). Never edit them by
hand — `tauri.conf.json` is what the updater compares against, so if it lags
behind, users are silently never offered the update.

```bash
npm run version:set 1.1.83   # bump everywhere
npm test                     # must pass
git commit -am "release 1.1.83" && git push origin main
```

Then GitHub Actions builds Windows + Linux and creates a **draft** release —
publish it manually so users' "Update App" button picks it up.

## Project structure

```
src/
  components/   Layout and shared UI
  context/      AppContext — global state + session handling
  pages/        Route-level pages
  test/         Vitest suites
  types/        TypeScript definitions
  utils/        storage, supabase, requireAuth, file processors
src-tauri/
  src/main.rs   Rust backend (embedded webview commands, updater)
scripts/        Version tooling and maintenance notes
supabase/       security-rls.sql — run this in the Supabase SQL editor
```

## Security

- The Supabase **anon key ships inside the app**, so it is public by design.
  It is only safe with Row Level Security enabled — run
  `supabase/security-rls.sql` in the Supabase SQL editor. Without it, any
  signed-in user can read and edit every other user's profile and backups.
- Authentication uses email + password via Supabase; passwords are never
  stored locally.
- The embedded webview navigates via parsed URLs rather than `eval`-ing
  JavaScript built from user input.

## License

MIT — see [LICENSE](./LICENSE)
