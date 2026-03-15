# Running NanoClaw in a Lima VM (Fedora + Podman)

Run NanoClaw inside an isolated Linux VM on your Mac using
[Lima](https://lima-vm.io/) 2.0+, with Podman as the container runtime.

## Why Lima + Podman?

- **VM-level isolation** --- NanoClaw and all agent containers run
  inside a Linux VM; nothing touches your Mac directly.
- **Rootless Podman** --- no daemon, no root privileges. Each agent
  container runs under your user's UID.
- **Fedora** --- Podman's home distribution, always ships the latest
  version.

## Prerequisites

- macOS with [Lima](https://lima-vm.io/) 2.0+ (`brew install lima`)
- An Anthropic API key (or OAuth token)

## Quick start

```bash
# Create and start the VM (provisions Node.js + Podman automatically)
limactl create --name nanoclaw lima/nanoclaw-fedora.yaml
limactl start nanoclaw
limactl shell nanoclaw

# Inside the VM --- install Claude Code (needed for /setup, /add-telegram, etc.)
curl -fsSL https://claude.ai/install.sh | sh

# The project is already mounted
cd ~/work/experiments/nanoclaw

# Native modules (better-sqlite3) must be compiled for Linux.
# If node_modules/ was installed on macOS, it contains Mach-O
# binaries that won't load on Linux ("invalid ELF header").
# Move node_modules to VM-local storage so host and VM don't
# clobber each other's platform-specific builds.
mkdir -p ~/nanoclaw-node_modules
rm -rf node_modules
ln -s ~/nanoclaw-node_modules node_modules
npm install

npm run build
CONTAINER_RUNTIME=podman bash container/build.sh

# Configure credentials
# NANOCLAW_DATA_DIR must point to VM-local storage (not the virtiofs mount)
# so Podman can read session files without SELinux blocking access.
mkdir -p ~/.local/share/nanoclaw/data
cat > .env << 'EOF'
ANTHROPIC_API_KEY=sk-ant-...
ASSISTANT_NAME=Andy
NANOCLAW_DATA_DIR=/home/<your-username>/.local/share/nanoclaw/data
EOF

# Run interactively to verify
npm start
```

Then run `/setup` inside Claude Code to add channels and register your main group.
`/setup` detects Podman automatically, configures `NANOCLAW_DATA_DIR`, adds `:z` SELinux
labels to container mounts, and starts the systemd service.

## Mount policy

Lima mounts control what the VM can see on your Mac. The Lima config
(`nanoclaw-fedora.yaml`) ships with a minimal mount policy.

### What is mounted

| Host path | VM path | Writable | Why |
|-----------|---------|----------|-----|
| `~/work/experiments/nanoclaw` | same | Yes | Project root. `store/`, `groups/`, and `logs/` are written here. |

> **Note:** `data/` (agent sessions, IPC) is **not** written to the project root on Lima. Because Lima mounts the Mac filesystem via virtiofs, those paths receive an `nfs_t` SELinux label that Podman containers cannot access — even with `:z`. Set `NANOCLAW_DATA_DIR` to a VM-local path so session data lives on the Linux filesystem. See [SELinux](#selinux) below.

### What is NOT mounted (and should not be)

| Path | Reason |
|------|--------|
| `~` (entire home) | Contains `.ssh`, `.gnupg`, `.aws`, `.kube`, browser profiles, and other sensitive material. Lima's default template mounts `~` --- we override it. |
| `~/.ssh` | SSH keys. Never needed by NanoClaw. |
| `~/.gnupg`, `~/.gpg` | GPG keys and trust database. |
| `~/.aws`, `~/.azure`, `~/.gcloud` | Cloud provider credentials. |
| `~/.kube` | Kubernetes configs and tokens. |
| `~/.docker`, `~/.local/share/containers` | Container runtime credentials and storage. |
| `~/.config` | Desktop and application configs, potentially contains tokens. |
| `~/.netrc`, `~/.npmrc`, `~/.pypirc` | Package registry credentials. |

### Adding host directories for agent access

If you want agents to read files from your Mac (e.g., an Obsidian
vault, a git repository), add them as **read-only** Lima mounts and
update the mount allowlist inside the VM.

**Step 1.** Add to `nanoclaw-fedora.yaml` before creating the VM:

```yaml
mounts:
- location: "~/work/experiments/nanoclaw"
  writable: true
- location: "~/Documents/notes"
  writable: false
```

**Step 2.** Inside the VM, add to
`~/.config/nanoclaw/mount-allowlist.json`:

```json
{
  "allowedRoots": [
    {
      "path": "~/Documents/notes",
      "allowReadWrite": false,
      "description": "Notes vault (read-only)"
    }
  ],
  "blockedPatterns": [],
  "nonMainReadOnly": true
}
```

**Step 3.** Configure the group's `additionalMounts` in the database
(via Claude Code or the setup scripts) to reference the path.

### Two-layer mount security

```
Mac filesystem
  │
  ├── Lima mount (nanoclaw-fedora.yaml)     ← outer boundary
  │     Only listed directories are visible inside the VM.
  │
  └── VM filesystem
        │
        ├── mount-allowlist.json             ← inner boundary
        │     Lives INSIDE the VM, outside the project root.
        │     Agent containers cannot modify it.
        │
        └── Podman container
              Only directories allowed by BOTH layers are visible
              to the agent.
```

A directory must pass both gates to reach an agent:

1. Listed in the Lima YAML (host exposes it to the VM)
2. Listed in mount-allowlist.json (VM exposes it to the container)

## Running as a systemd service

Inside the VM:

```bash
cd ~/work/experiments/nanoclaw
npm run build

# Create and start the service
cat > ~/.config/systemd/user/nanoclaw.service << EOF
[Unit]
Description=NanoClaw Personal Assistant
After=network.target

[Service]
Type=simple
ExecStart=$(which node) $(pwd)/dist/index.js
WorkingDirectory=$(pwd)
Restart=always
RestartSec=5
Environment=HOME=$HOME
Environment=PATH=/usr/local/bin:/usr/bin:/bin:$HOME/.local/bin

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now nanoclaw
systemctl --user status nanoclaw
```

The Lima YAML already enables `loginctl enable-linger` so your
service keeps running after you disconnect.

## Podman-specific notes

### Rootless networking

Podman runs rootless by default. Agent containers reach the
credential proxy via `host.containers.internal`, which Podman
resolves automatically (4.7+). The NanoClaw Podman support passes
`--userns=keep-id` so bind-mounted files have correct ownership.

### Image compatibility

The `container/Dockerfile` is a standard OCI Dockerfile. Podman
builds it with `podman build` --- no changes needed:

```bash
CONTAINER_RUNTIME=podman bash container/build.sh
```

### SELinux

Fedora enables SELinux by default. NanoClaw handles this in two ways:

**Bind mounts: `:z` added automatically**

`container-runtime.ts` appends `:z` to all Podman bind mounts so SELinux
relabels them to `container_file_t`, allowing the container process to read
and write them. Device paths (e.g. `/dev/null`) are excluded from relabeling.

**virtiofs mounts: must stay out of containers**

Lima mounts the Mac filesystem via virtiofs. Linux assigns these paths the
`nfs_t` SELinux label, and `:z` cannot relabel NFS/virtiofs paths — the kernel
rejects the `setxattr` call. This means any directory that lives inside the
Lima-mounted project root **cannot be bind-mounted into a Podman container**.

The affected directory is `data/` (agent sessions, IPC sockets). The fix is to
redirect it to VM-local storage via `NANOCLAW_DATA_DIR`:

```bash
mkdir -p ~/.local/share/nanoclaw/data
echo "NANOCLAW_DATA_DIR=$HOME/.local/share/nanoclaw/data" >> .env
```

`/setup` sets this automatically when it detects Podman on Linux. If you set up
manually, add the line above before starting the service.

`store/`, `groups/`, and `logs/` remain in the project root — they are written
by the host Node.js process, not mounted into containers, so `nfs_t` does not
affect them.

## Troubleshooting

### "invalid ELF header" on better-sqlite3 (or other native module)

The project directory is mounted from macOS. If `npm install` ran on
the Mac first, `node_modules/` contains macOS (Mach-O) native binaries
that Linux cannot load.

Fix: move `node_modules` to VM-local storage so each platform keeps
its own compiled binaries:

```bash
mkdir -p ~/nanoclaw-node_modules
rm -rf node_modules
ln -s ~/nanoclaw-node_modules node_modules
npm install
```

The symlink lives in the shared mount but points to `~/` which is
VM-local (not mounted from the host). Your Mac's `node_modules`
stays untouched.

If you only run NanoClaw inside the VM and never on the Mac,
`npm rebuild` is a simpler alternative --- but it overwrites the
macOS binaries in the shared directory.

### Container fails: "Permission denied" on sessions or "No inputs were found" in tsc

These two errors share the same root cause: `data/sessions/` is inside the
Lima-mounted project directory, which has the `nfs_t` SELinux label. Podman
containers (running as `container_t`) cannot read `nfs_t` paths, even with `:z`.

The symptom chain:
1. First run: container can't copy skill files → partial directory left with broken permissions
2. Retries: can't delete the partial directory → `ENOTEMPTY` or `EACCES`
3. Even if files copy successfully: `nfs_t` blocks container read → `tsc` sees an empty `src/` → `TS18003`

**Fix:** redirect `data/` to VM-local storage:

```bash
mkdir -p ~/.local/share/nanoclaw/data
echo "NANOCLAW_DATA_DIR=$HOME/.local/share/nanoclaw/data" >> .env
cp .env data/env/env   # sync to container env
systemctl --user restart nanoclaw
```

You can confirm the denial with:

```bash
sudo ausearch -m avc -ts recent | grep container_t | grep nfs_t
```

### Bot stops responding after first reply (stale session loop)

**Symptom:** The bot answers the first message, but follow-up messages get no response.
The log shows the container repeatedly failing with:

```
Agent error: Claude Code returned an error result: No conversation found with session ID: <uuid>
```

**Cause:** An idle container was killed (e.g. `podman stop` or service restart while a
conversation was in progress). The session ID from that container is persisted in SQLite,
so every retry tries to resume a conversation that no longer exists.

**Fix:**

```bash
# 1. Clear the stale session
sqlite3 store/messages.db "DELETE FROM sessions WHERE group_folder='telegram_main';"

# 2. Find the timestamp of the last successfully delivered message in the log,
#    then reset the cursor to just after it so missed messages are re-queued.
#    Replace the timestamp below with the one from your log.
sqlite3 store/messages.db "
  UPDATE router_state SET value='2026-03-15T14:41:46.000Z' WHERE key='last_timestamp';
  UPDATE router_state SET value='{\"tg:336249536\":\"2026-03-15T14:41:46.000Z\"}' WHERE key='last_agent_timestamp';
"

# 3. Restart the service — recovery will re-queue unprocessed messages
systemctl --user restart nanoclaw
```

The timestamp to use is the moment the last response was *sent* (look for
`Telegram message sent` or similar in `logs/nanoclaw.log`), not when the
follow-up messages arrived.

### "permission denied" connecting to Podman socket

Podman is daemonless --- there is no socket to connect to by default.
If `podman info` fails, ensure the `podman` package is installed:

```bash
sudo dnf install -y podman
podman info
```

### Container build fails with missing build tools

Native npm modules (like `better-sqlite3`) need a C++ compiler:

```bash
sudo dnf install -y gcc-c++ make python3
```

The Lima provisioning script installs these automatically.

### Agent containers cannot reach the Anthropic API

Verify the credential proxy is reachable from inside a container:

```bash
podman run --rm curlimages/curl \
  curl -s http://host.containers.internal:3001/
```

If this fails, check that `PROXY_BIND_HOST` is set to `0.0.0.0`
(the default for Podman in `container-runtime.ts`).

### Lima mount not visible inside the VM

Verify the mount is listed in the YAML and the VM was created
(not just restarted) after the change:

```bash
limactl stop nanoclaw
limactl delete nanoclaw
limactl create --name nanoclaw lima/nanoclaw-fedora.yaml
limactl start nanoclaw
```

Lima mounts are set at VM creation time; adding a mount to the
YAML after creation requires recreating the VM.
