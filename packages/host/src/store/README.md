# Store

The host calls `openStore(path)` once and owns the migrated connection; the
`create*Store` factories borrow it and never migrate, close or configure it.
`openRunStore(path)` is the owning wrapper for other processes, such as the desktop
smoke and the crash tests.

The connection uses WAL and `synchronous=FULL`, and opening fails if WAL cannot be
enabled. That is what keeps committed rows across a `SIGKILL`. It does not protect
against a second host process or manual database changes.

A store read error propagates. It never proves an empty record, a successful read
or lease ownership.

The crash tests run the compiled store in a child process: build the host
(`pnpm --filter @spi-code/host build`) before running one alone.
