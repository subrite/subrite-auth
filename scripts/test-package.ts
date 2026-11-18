// Checks the package the way apps get it from npm: builds and packs it, unpacks it into the
// fixture apps in test/package, then type checks and imports it there.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const fixtures = join(root, 'test', 'package');
const tsc = join(root, 'node_modules', '.bin', 'tsc');

function run(command: string, args: string[], cwd = root): void {
  execFileSync(command, args, { cwd, stdio: 'inherit' });
}

// The README components in the fixture app must match the README, so the docs stay compiled.
const readme = readFileSync(join(root, 'README.md'), 'utf8');
const readmeBlocks = [...readme.matchAll(/```(?:tsx|typescript)\n([\s\S]*?)```/g)].map(
  (match) => match[1],
);
const copyHeader =
  '// Copied from the README. scripts/test-package.ts checks that it still matches.\n';
const copies = [
  'options.ts',
  'next-auth.d.ts',
  'sign-out-button.tsx',
  'logout-page.tsx',
  'session-guard.tsx',
];
for (const file of copies) {
  const copy = readFileSync(join(fixtures, 'current', file), 'utf8');
  if (!copy.startsWith(copyHeader) || !readmeBlocks.includes(copy.slice(copyHeader.length))) {
    throw new Error(`test/package/current/${file} no longer matches its code block in README.md`);
  }
}

run('npm', ['run', 'compile']);

const packDir = mkdtempSync(join(tmpdir(), 'subrite-pack-'));
try {
  const output = execFileSync(
    'npm',
    ['pack', '--ignore-scripts', '--json', '--pack-destination', packDir],
    { cwd: root, encoding: 'utf8' },
  );
  const [{ filename }] = JSON.parse(output) as [{ filename: string }];
  const target = join(fixtures, 'node_modules', '@subrite', 'next-auth-provider');
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  run('tar', ['-xzf', join(packDir, filename), '-C', target, '--strip-components=1']);
} finally {
  rmSync(packDir, { recursive: true, force: true });
}

const configs = readdirSync(fixtures)
  .filter((file) => /^tsconfig\..+\..+\.json$/.test(file))
  .sort();
for (const config of configs) {
  console.log(`Type checking test/package/${config}`);
  run(tsc, ['-p', join(fixtures, config)]);
}

const check = `
  if (typeof api.default !== 'function') throw new Error('no default export');
  for (const name of ['toSubriteJWT', 'refreshAccessToken', 'generatePostSignOutUrl', 'isAccessTokenExpired']) {
    if (typeof api[name] !== 'function') throw new Error('missing export ' + name);
  }
  const provider = api.default({ clientId: 'id', clientSecret: 'secret', subriteUrl: 'https://example.com' });
  if (provider.id !== 'subrite') throw new Error('unexpected provider id');
`;
console.log('Importing the package with import');
run(
  process.execPath,
  ['--input-type=module', '-e', `import * as api from '@subrite/next-auth-provider';${check}`],
  fixtures,
);
console.log('Importing the package with require');
run(
  process.execPath,
  ['--input-type=commonjs', '-e', `const api = require('@subrite/next-auth-provider');${check}`],
  fixtures,
);

console.log('Package check passed');
