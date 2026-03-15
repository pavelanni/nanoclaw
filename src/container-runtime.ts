/**
 * Container runtime abstraction for NanoClaw.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 *
 * Supported runtimes: docker, podman, apple-container
 * Auto-detected at startup; override with CONTAINER_RUNTIME env var.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';

import { logger } from './logger.js';

type Runtime = 'docker' | 'podman';

function detectRuntime(): Runtime {
  const override = process.env.CONTAINER_RUNTIME;
  if (override === 'podman' || override === 'docker') return override;

  // Prefer podman if available (rootless by default, no daemon required)
  try {
    execSync('command -v podman', { stdio: 'pipe' });
    return 'podman';
  } catch {
    // fall through
  }
  return 'docker';
}

const RUNTIME: Runtime = detectRuntime();

/** The container runtime binary name. */
export const CONTAINER_RUNTIME_BIN = RUNTIME;

/** Hostname containers use to reach the host machine. */
export const CONTAINER_HOST_GATEWAY =
  RUNTIME === 'podman' ? 'host.containers.internal' : 'host.docker.internal';

/**
 * Address the credential proxy binds to.
 * Docker Desktop (macOS): 127.0.0.1 — the VM routes host.docker.internal to loopback.
 * Docker (Linux): bind to the docker0 bridge IP so only containers can reach it,
 *   falling back to 0.0.0.0 if the interface isn't found.
 * Podman (Linux rootless): 0.0.0.0 — slirp4netns/pasta maps host.containers.internal
 *   to the host's loopback; binding to the bridge won't work.
 */
export const PROXY_BIND_HOST =
  process.env.CREDENTIAL_PROXY_HOST || detectProxyBindHost();

function detectProxyBindHost(): string {
  if (os.platform() === 'darwin') return '127.0.0.1';

  // WSL uses Docker Desktop (same VM routing as macOS) — loopback is correct.
  // Check /proc filesystem, not env vars — WSL_DISTRO_NAME isn't set under systemd.
  if (fs.existsSync('/proc/sys/fs/binfmt_misc/WSLInterop')) return '127.0.0.1';

  if (RUNTIME === 'podman') {
    // Rootless podman uses slirp4netns/pasta networking. There's no bridge
    // interface on the host — host.containers.internal resolves to 10.0.2.2
    // (slirp4netns) or the host loopback (pasta). Bind to 0.0.0.0 so the
    // proxy is reachable regardless of network mode.
    return '0.0.0.0';
  }

  // Bare-metal Linux with Docker: bind to the docker0 bridge IP instead of 0.0.0.0
  const ifaces = os.networkInterfaces();
  const docker0 = ifaces['docker0'];
  if (docker0) {
    const ipv4 = docker0.find((a) => a.family === 'IPv4');
    if (ipv4) return ipv4.address;
  }
  return '0.0.0.0';
}

/** CLI args needed for the container to resolve the host gateway. */
export function hostGatewayArgs(): string[] {
  if (RUNTIME === 'podman') {
    // Podman 4.7+ resolves host.containers.internal automatically.
    // Older versions need an explicit mapping.
    return ['--add-host=host.containers.internal:host-gateway'];
  }
  // On Linux, host.docker.internal isn't built-in — add it explicitly
  if (os.platform() === 'linux') {
    return ['--add-host=host.docker.internal:host-gateway'];
  }
  return [];
}

/**
 * CLI args for user namespace mapping.
 * Docker: --user UID:GID so bind-mounted files are accessible.
 * Podman rootless: --userns=keep-id maps the host UID into the container.
 */
export function userMappingArgs(): string[] {
  if (RUNTIME === 'podman') {
    return ['--userns=keep-id'];
  }

  // Docker: run as host user so bind-mounted files are accessible.
  // Skip when running as root (uid 0), as the container's node user (uid 1000),
  // or when getuid is unavailable (native Windows without WSL).
  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  if (hostUid != null && hostUid !== 0 && hostUid !== 1000) {
    return ['--user', `${hostUid}:${hostGid}`];
  }
  return [];
}

/** Returns CLI args for a readonly bind mount. */
export function readonlyMountArgs(
  hostPath: string,
  containerPath: string,
): string[] {
  // Podman on SELinux requires :z to relabel for container access.
  // Skip for device files like /dev/null which can't be relabeled.
  const selinuxLabel =
    RUNTIME === 'podman' && !hostPath.startsWith('/dev/') ? ',z' : '';
  return ['-v', `${hostPath}:${containerPath}:ro${selinuxLabel}`];
}

/** Returns the volume mount option suffix for writable mounts. */
export function writableMountSuffix(): string {
  return RUNTIME === 'podman' ? ':z' : '';
}

/** Returns the shell command to stop a container by name. */
export function stopContainer(name: string): string {
  return `${CONTAINER_RUNTIME_BIN} stop ${name}`;
}

/** Ensure the container runtime is running, starting it if needed. */
export function ensureContainerRuntimeRunning(): void {
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} info`, {
      stdio: 'pipe',
      timeout: 10000,
    });
    logger.debug({ runtime: RUNTIME }, 'Container runtime already running');
  } catch (err) {
    logger.error(
      { err, runtime: RUNTIME },
      'Failed to reach container runtime',
    );
    console.error(
      '\n╔════════════════════════════════════════════════════════════════╗',
    );
    console.error(
      '║  FATAL: Container runtime failed to start                      ║',
    );
    console.error(
      '║                                                                ║',
    );
    console.error(
      '║  Agents cannot run without a container runtime. To fix:        ║',
    );
    console.error(
      `║  1. Ensure ${RUNTIME} is installed and running${' '.repeat(Math.max(0, 24 - RUNTIME.length))}║`,
    );
    console.error(
      `║  2. Run: ${RUNTIME} info${' '.repeat(Math.max(0, 35 - RUNTIME.length))}║`,
    );
    console.error(
      '║  3. Restart NanoClaw                                           ║',
    );
    console.error(
      '╚════════════════════════════════════════════════════════════════╝\n',
    );
    throw new Error('Container runtime is required but failed to start');
  }
}

/** Kill orphaned NanoClaw containers from previous runs. */
export function cleanupOrphans(): void {
  try {
    const output = execSync(
      `${CONTAINER_RUNTIME_BIN} ps --filter name=nanoclaw- --format '{{.Names}}'`,
      { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' },
    );
    const orphans = output.trim().split('\n').filter(Boolean);
    for (const name of orphans) {
      try {
        execSync(stopContainer(name), { stdio: 'pipe' });
      } catch {
        /* already stopped */
      }
    }
    if (orphans.length > 0) {
      logger.info(
        { count: orphans.length, names: orphans },
        'Stopped orphaned containers',
      );
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up orphaned containers');
  }
}
