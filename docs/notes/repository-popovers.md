# Repository popovers

`components/place/RepositoryLine.tsx` is reusable by Environment and service repository lists: pass the repository name, section, core line, snapshot and its JSON pointer. Its `rline` selection id is `<repository>|<line id>` (the pointer is the fallback for unidentified lines), so the Engineering system table can reopen the same line after Evidence. It imports the shared Popover, whose OpenedBody uses core's `onToday` and counted Can wait URLs; a missing association claims neither membership nor a counted disposition. No Copilot actions are added.
