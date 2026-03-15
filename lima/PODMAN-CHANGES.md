# Podman Support Changes

Changes made to add Podman support (branch `feature/podman-support`).
Filed under upstream issue #957. A focused PR with Podman-only changes
may be opened if there is upstream interest.

## Podman-specific changes

### `src/container-runtime.ts`
- **Auto-detect Podman**: prefers `podman` if available on PATH, falls back to `docker`
- **`:z` SELinux label on bind mounts**: Fedora/RHEL enables SELinux by default; all
  Podman volume mounts need `:z` so the container process (`container_t`) can read them.
  `/dev/` paths are excluded (cannot relabel device nodes).
- **`--userns=keep-id`**: maps the host user's UID into the container so bind-mounted
  files have correct ownership.
- **`PROXY_BIND_HOST=0.0.0.0`**: Podman is daemonless; agents reach the credential
  proxy via `host.containers.internal`, which requires the proxy to bind on all interfaces.
- Exported `writableMountSuffix()` so `container-runner.ts` can apply `:z` to writable
  mounts too.

### `src/container-runner.ts`
- Uses `writableMountSuffix()` (`:z`) on all writable bind mounts (sessions dir, IPC
  dir, group dir).
- **IPC input dir created with `chmod 0777`**: Podman runs with `--userns=keep-id` but
  the container process is `USER node` (uid 1000), while the host writes IPC files as
  the host user (e.g. uid 501). The container needs to `unlink` files it didn't create —
  that requires write permission on the *parent directory*, not just the file. `0o777`
  (no sticky bit) enables this.
- **Host-side IPC cleanup after container exit**: if the container exits without
  consuming pending IPC files (e.g. killed while idle), the host cleans up `input/` to
  avoid ghost messages on the next run.

### `src/config.ts`
- **`NANOCLAW_DATA_DIR` env var**: Lima mounts the project root via virtiofs, which
  gets the `nfs_t` SELinux label. Podman containers (`container_t`) cannot access
  `nfs_t` paths even with `:z`. `data/` (sessions, IPC) must live on VM-local storage.
  This env var redirects `DATA_DIR` to a writable local path.

### `lima/` directory (new)
- `lima/nanoclaw-fedora.yaml`: Lima VM config with Fedora + Podman, minimal mount
  policy (project root only, not `~`), and a provision script that installs Node.js,
  Podman, build tools, git, and sqlite3.
- `lima/SETUP.md`: Step-by-step guide for running NanoClaw inside a Lima VM with
  Podman, including mount policy rationale, SELinux notes, and troubleshooting.
- `lima/PODMAN-CHANGES.md`: This file.

## General bugs fixed alongside (not Podman-specific)

These were discovered during Lima/Podman testing but affect all platforms:

### Stale session detection (`src/index.ts`, `src/db.ts`)
When Claude Code reports "No conversation found with session ID", the session is now
cleared from SQLite so the next container starts a fresh session instead of looping.

### `chmodSync` after IPC file writes (`src/group-queue.ts`)
`writeFileSync({mode: 0o666})` is masked by the process umask (022) to 0644.
Explicit `chmodSync(path, 0o666)` after write ensures the container can read the file.

### Skills dir `rmSync` before `cpSync` (`src/container-runner.ts`)
Prevents stale partial skill directories accumulating across restarts (was causing
`ENOTEMPTY` / `EACCES` on retry).
