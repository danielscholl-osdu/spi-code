# Thread view

- `apps/window/src/threads` draws data it is given: its props are the types in `types.ts`, and it imports no host client. The thread route and entry points wire it (spicode-xia.8).
- Highlighted rows in the composer's menus and the model picker sit on `--surface-raised`, never `--hover`: muted words on `--hover` fall under 4.5:1 in Warm dark, and the palette test gates every text role on `--surface-raised`.
- macOS resolves imports case-insensitively, so a `timeline.ts` beside `Timeline.tsx` shadows it under Vite. The pure row module is `rows.ts`.
- The list mounts at most `ROW_BUDGET` rows and follows the end while the reader is there; a work group's open state lives in the timeline, so a row scrolled out and back keeps it.
