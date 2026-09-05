import { expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import metadata from '../../../package.json';

test('the public installer wires its options and rejects a corrupt download without replacing Cone', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cone-installer-test-'));
  const payload = join(root, 'payload');
  mkdirSync(payload);
  const executable = `#!/bin/sh\nset -eu\nif [ "$1" = --version ]; then echo 'cone ${metadata.version}'; else printf '%s\\n' "$*" >> "$CONE_INSTALL_TEST_LOG"; printf '{"ok":true}\\n'; fi\n`;
  await Bun.write(join(payload, 'cone'), executable);
  chmodSync(join(payload, 'cone'), 0o755);
  await Bun.write(join(payload, 'LICENSE'), 'Fixture license');
  await Bun.write(join(payload, 'THIRD_PARTY_NOTICES.txt'), 'Fixture notices');
  const archive = `cone-${metadata.version}-${process.platform}-${process.arch}.tar.gz`;
  const archivePath = join(root, archive);
  const tar = Bun.spawn(['tar', '-czf', archivePath, '-C', payload, 'cone', 'LICENSE', 'THIRD_PARTY_NOTICES.txt'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  expect(await tar.exited).toBe(0);
  const digest = new Bun.CryptoHasher('sha256').update(await Bun.file(archivePath).arrayBuffer()).digest('hex');
  let corrupt = false;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    if (path.endsWith('/SHA256SUMS')) return new Response(`${corrupt ? '0'.repeat(64) : digest}  ${archive}\n`);
    if (path.endsWith(`/${archive}`)) return new Response(Bun.file(archivePath));
    return new Response('missing', { status: 404 });
  } });
  const bin = join(root, 'bin');
  const log = join(root, 'commands');
  const run = async () => {
    const child = Bun.spawn(['sh', resolve(import.meta.dir, '../../../install.sh'), '--hermes', '--no-restart', '--env', 'dev', '--connect', 'peer-id', '--name', 'Peer'], {
      cwd: root, env: { ...process.env, CONE_RELEASE_BASE: String(server.url).replace(/\/$/, ''), CONE_VERSION: metadata.version,
        CONE_BIN_DIR: bin, CONE_HOME: join(root, 'identity'), CONE_INSTALL_TEST_LOG: log }, stdout: 'pipe', stderr: 'pipe',
    });
    const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text(), new Response(child.stdout).text()]);
    return { exit, stderr };
  };
  try {
    expect((await run()).exit).toBe(0);
    expect(await Bun.file(log).text()).toBe(`init --env dev\nconnect peer-id --name Peer\nintegrate hermes --binary ${bin}/cone --name hermes --no-restart\n`);
    expect(await Bun.file(join(root, 'identity/licenses/THIRD_PARTY_NOTICES.txt')).text()).toBe('Fixture notices');
    corrupt = true;
    const rejected = await run();
    expect(rejected.exit).toBe(1);
    expect(rejected.stderr).toContain('checksum verification');
    expect(await Bun.file(join(bin, 'cone')).text()).toBe(executable);
    expect((await Bun.file(log).text()).split('\n')).toHaveLength(4);
  } finally { server.stop(true); rmSync(root, { recursive: true, force: true }); }
});
