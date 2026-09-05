import { dirname, join, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import metadata from '../package.json';

const targets = {
  'darwin-arm64': { runtime: 'bun-darwin-arm64', binding: 'darwin-arm64' },
  'linux-x64': { runtime: 'bun-linux-x64-baseline', binding: 'linux-x64-gnu' },
  'linux-arm64': { runtime: 'bun-linux-arm64', binding: 'linux-arm64-gnu' },
} as const;
const name = process.argv[2] ?? `${process.platform}-${process.arch}`;
if (!(name in targets)) throw new Error(`Unsupported target: ${name}. Supported targets: ${Object.keys(targets).join(', ')}`);
const target = targets[name as keyof typeof targets];
const root = resolve(import.meta.dir, '..');
const bindings = Bun.resolveSync('@xmtp/node-bindings', join(root, 'packages/xmtp-node'));
const nativePath = join(dirname(bindings), `bindings_node.${target.binding}.node`);
const outdir = join(root, 'dist', `cone-${metadata.version}-${name}`);
mkdirSync(outdir, { recursive: true });
const result = await Bun.build({
  entrypoints: [join(root, 'packages/cli/src/bin.ts')],
  compile: { outfile: join(outdir, 'cone'), target: target.runtime },
  minify: true,
  plugins: [{ name: 'embedded-xmtp', setup(build) {
    build.onLoad({ filter: /node-bindings\/dist\/index\.js$/ }, async ({ path }) => {
      const names = [...(await Bun.file(path).text()).matchAll(/^export \{ (\w+) \}/gm)].map(match => match[1]);
      return { loader: 'js', contents:
        `import nativePath from ${JSON.stringify(nativePath)} with {type:'file'};
         import {createRequire} from 'node:module';
         const binding=createRequire(import.meta.url)(nativePath);
         ${names.map(name => `export const ${name}=binding.${name};`).join('\n')}` };
    });
  }}],
});
if (!result.success) throw new AggregateError(result.logs, 'Cone build failed');
console.log(join(outdir, 'cone'));
