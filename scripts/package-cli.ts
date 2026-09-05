import { dirname, join, resolve } from 'node:path';
import { readdirSync, realpathSync } from 'node:fs';
import metadata from '../package.json';

const root = resolve(import.meta.dir, '..');
const target = process.argv[2] ?? `${process.platform}-${process.arch}`;
if (!['darwin-arm64', 'linux-x64', 'linux-arm64'].includes(target)) throw new Error('Unsupported release target');
const directory = join(root, 'dist', `cone-${metadata.version}-${target}`);
if (!await Bun.file(join(directory, 'cone')).exists()) throw new Error('Build the executable first');
await Bun.write(join(directory, 'LICENSE'), Bun.file(join(root, 'LICENSE')));

const visited = new Set<string>();
const notices: string[] = [];
async function licenses(directory: string): Promise<void> {
  directory = realpathSync(directory);
  if (visited.has(directory)) return;
  visited.add(directory);
  const pkg = await Bun.file(join(directory, 'package.json')).json();
  if (!pkg.name) throw new Error(`Package metadata has no name: ${directory}`);
  if (!pkg.name.startsWith('@cone/')) {
    const texts = await Promise.all(readdirSync(directory).filter(name => /^(LICENSE|LICENCE|COPYING|NOTICE)(\.|$)/i.test(name))
      .map(async name => `${name}\n${await Bun.file(join(directory, name)).text()}`));
    notices.push(`## ${pkg.name} ${pkg.version}\nLicense: ${JSON.stringify(pkg.license ?? 'See upstream source')}\n${texts.join('\n')}`);
  }
  for (const name of Object.keys(pkg.dependencies ?? {}).sort()) {
    let file: string;
    try { file = Bun.resolveSync(`${name}/package.json`, directory); }
    catch { file = Bun.resolveSync(name, directory); }
    let candidate = dirname(file);
    while (!await Bun.file(join(candidate, 'package.json')).exists() ||
      (await Bun.file(join(candidate, 'package.json')).json()).name !== name) {
      if (dirname(candidate) === candidate) throw new Error(`Cannot find license metadata for ${name}`);
      candidate = dirname(candidate);
    }
    await licenses(candidate);
  }
}
await licenses(join(root, 'packages/cli'));
const bunLicense = await Bun.file(join(root, 'vendor/licenses/Bun-1.3.11.md')).text();
await Bun.write(join(directory, 'THIRD_PARTY_NOTICES.txt'), [
  `Cone ${metadata.version} source and build instructions: https://github.com/emlazzarin/cone/tree/v${metadata.version}`,
  'Bun runtime 1.3.11: https://github.com/oven-sh/bun/tree/bun-v1.3.11', bunLicense, ...notices.sort(),
].join('\n\n'));
const archive = `cone-${metadata.version}-${target}.tar.gz`;
const output = join(root, 'dist', archive);
const child = Bun.spawn(['tar', '--format=ustar', '-czf', output, '-C', directory, 'cone', 'LICENSE', 'THIRD_PARTY_NOTICES.txt'],
  { env: { ...process.env, COPYFILE_DISABLE: '1' }, stdout: 'inherit', stderr: 'inherit' });
if (await child.exited !== 0) throw new Error('Archive creation failed');
const checksum = new Bun.CryptoHasher('sha256').update(await Bun.file(output).arrayBuffer()).digest('hex');
await Bun.write(`${output}.sha256`, `${checksum}  ${archive}\n`);
console.log(output);
