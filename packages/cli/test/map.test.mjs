import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { main } from '../src/cli.mjs';
import { LIMITS, formatMermaid, map, matchRoute, normalizeTarget, routeOf } from '../src/map.mjs';

const catalog = { schemaVersion: 1, placements: [
  { key: 'travel.coast', symbol: ['Travel', 'coast'], width: 1200, height: 900 },
  { key: 'tasks.garden', symbol: ['Tasks', 'garden'], width: 600, height: 400 },
  { key: 'hero.art', symbol: ['Hero', 'art'], width: 100, height: 100 },
] };
const screen = 'export default function Screen() { return null; }\n';

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'assetlib-map-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const put = async (name, text) => { const file = path.join(root, name); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, text); return file; };
  const catalogPath = await put('assetlib.catalog.json', JSON.stringify(catalog));
  const scan = options => map({ catalog, catalogPath, ...options });
  async function run(args, json = false) {
    let stdout = '', stderr = '';
    const code = await main(['map', '--catalog', catalogPath, ...args], {}, { stdout: { write: text => { stdout += text; } }, stderr: { write: text => { stderr += text; } } });
    return { code, stdout, stderr, ...(json ? { report: JSON.parse(stdout) } : {}) };
  }
  return { root, put, catalogPath, scan, run };
}
const edgesOf = report => report.edges.map(edge => `${edge.kind} ${edge.call} ${edge.from} -> ${edge.to} ${edge.target} ${edge.file}:${edge.line}${edge.via.length ? ` via ${edge.via.join('>')}` : ''}`).sort();
const placementsOf = node => node.placements.map(item => `${item.key} ${item.file}:${item.line}${item.via.length ? ` via ${item.via.join('>')}` : ''}`).sort();
const routeOfFile = (report, file) => report.routes.find(node => node.file === file);

test('names routes like Expo Router: groups, params, index, layouts, platforms, and the files that are not routes', async t => {
  const f = await fixture(t);
  for (const file of ['src/app/_layout.tsx', 'src/app/index.tsx', 'src/app/(tabs)/_layout.tsx', 'src/app/(tabs)/index.tsx', 'src/app/(tabs)/home.tsx', 'src/app/(tabs)/home.ios.tsx',
    'src/app/(tabs)/web-only.web.tsx', 'src/app/trip/[id].tsx', 'src/app/[...rest].tsx', 'src/app/+not-found.tsx', 'src/app/settings/index.tsx', 'src/app/settings/_layout.tsx', 'src/app/settings/(modal)/edit.tsx',
    'src/app/+html.tsx', 'src/app/+native-intent.tsx', 'src/app/api/users+api.ts', 'src/app/+middleware.ts', 'src/app/types.d.ts', 'src/app/assets.generated.ts', 'src/app/notes.md']) {
    await f.put(file, file.endsWith('.ts') ? 'export const x = 1;\n' : screen);
  }
  const report = await f.scan();
  assert.equal(report.app, 'src/app');
  assert.deepEqual(report.routes.map(node => [node.kind, node.route, node.file, node.groups.join(','), node.layout]), [
    ['layout', '/', 'src/app/(tabs)/_layout.tsx', 'tabs', 'src/app/_layout.tsx'],
    ['route', '/home', 'src/app/(tabs)/home.tsx', 'tabs', 'src/app/(tabs)/_layout.tsx'],
    ['route', '/', 'src/app/(tabs)/index.tsx', 'tabs', 'src/app/(tabs)/_layout.tsx'],
    ['route', '/web-only', 'src/app/(tabs)/web-only.web.tsx', 'tabs', 'src/app/(tabs)/_layout.tsx'],
    ['route', '/+not-found', 'src/app/+not-found.tsx', '', 'src/app/_layout.tsx'],
    ['route', '/[...rest]', 'src/app/[...rest].tsx', '', 'src/app/_layout.tsx'],
    ['layout', '/', 'src/app/_layout.tsx', '', null],
    ['route', '/', 'src/app/index.tsx', '', 'src/app/_layout.tsx'],
    ['route', '/settings/edit', 'src/app/settings/(modal)/edit.tsx', 'modal', 'src/app/settings/_layout.tsx'],
    ['layout', '/settings', 'src/app/settings/_layout.tsx', '', 'src/app/_layout.tsx'],
    ['route', '/settings', 'src/app/settings/index.tsx', '', 'src/app/settings/_layout.tsx'],
    ['route', '/trip/[id]', 'src/app/trip/[id].tsx', '', 'src/app/_layout.tsx'],
  ]);
  assert.deepEqual(report.routes.filter(node => node.kind === 'route').map(node => node.entry), [false, true, false, false, false, true, false, false, false]);
  assert.deepEqual(report, JSON.parse(JSON.stringify(report)));
  assert.equal(report.partial, false);
  // src/app wins over app, as in Expo Router; an explicit --app is taken as given; neither present is an error.
  await f.put('app/index.tsx', screen);
  assert.equal((await f.scan()).routes.length, 12);
  assert.deepEqual((await f.scan({ app: path.join(f.root, 'app') })).routes.map(node => node.file), ['app/index.tsx']);
  // --root selects a parent that holds both the catalog and the app directory.
  const nested = await f.put('src/config/assetlib.catalog.json', JSON.stringify(catalog));
  assert.equal((await map({ catalog, catalogPath: nested, root: f.root })).routes.length, 12);
  await assert.rejects(map({ catalog, catalogPath: nested }), /No Expo Router app directory/);
  await rm(path.join(f.root, 'src'), { recursive: true });
  assert.deepEqual((await f.scan()).routes.map(node => node.file), ['app/index.tsx']);
  await rm(path.join(f.root, 'app'), { recursive: true });
  await assert.rejects(f.scan(), /No Expo Router app directory/);
  await symlink(f.root, path.join(f.root, 'app'));
  await assert.rejects(f.scan({ app: path.join(f.root, 'app') }), /real directory/);
  assert.deepEqual(routeOf('(a)/b/(c)/[d]/index'), { kind: 'route', route: '/b/[d]', groups: ['a', 'c'] });
});

test('reads every navigation pattern: Link and Redirect hrefs, router calls, objects, templates, conditionals, and dynamic values', async t => {
  const f = await fixture(t);
  for (const file of ['app/a.tsx', 'app/b.tsx', 'app/c.tsx', 'app/trip/[id].tsx']) await f.put(file, screen);
  await f.put('app/index.tsx', `import { Link, Redirect, useRouter, router as globalRouter, Link as RouterLink } from 'expo-router';
import { Link as WebLink } from 'react-router';
export default function Index({ ok, id, variable }) {
  const router = useRouter();
  const nav = useRouter();
  const { push, replace: swap } = useRouter();
  const items = [];
  items.push('/a');
  router.push('/a');
  nav.navigate('/b?x=1#y');
  push('/c');
  swap({ pathname: '/trip/[id]', params: { id } });
  globalRouter.replace(\`/trip/\${id}\`);
  useRouter().navigate('./c');
  router.push('a');
  router.push(variable);
  router.push();
  router.push(\`/trip/\${id}-x\`);
  router.push(ok ? '/a' : variable);
  router.push('/a' as Href);
  return <>
    <Link href="/a" />
    <Link href={'/(tabs)/b/'} />
    <RouterLink href="/c" />
    <WebLink href="/a" />
    <Redirect href={ok ? '/a' : '/b'} />
    <Link href={{ params: { id } }} />
    <Link href="/missing" />
    <Link href={variable ?? '/b'} />
    <Link href={variable || '/c'} />
  </>;
}
`);
  await f.put('app/two.tsx', "import { Link } from 'expo-router';\nexport default () => <><Link href=\"/a\" /><Link href=\"/b\" /></>;\n");
  const report = await f.scan();
  assert.deepEqual(edgesOf(report), [
    'conditional Link app/index.tsx -> app/b.tsx /b app/index.tsx:29',
    'conditional Link app/index.tsx -> app/c.tsx /c app/index.tsx:30',
    'conditional Redirect app/index.tsx -> app/a.tsx /a app/index.tsx:26',
    'conditional Redirect app/index.tsx -> app/b.tsx /b app/index.tsx:26',
    'conditional router.push app/index.tsx -> app/a.tsx /a app/index.tsx:19',
    'dynamic Link app/index.tsx -> null null app/index.tsx:27',
    'dynamic Link app/index.tsx -> null null app/index.tsx:29',
    'dynamic Link app/index.tsx -> null null app/index.tsx:30',
    'dynamic router.push app/index.tsx -> null null app/index.tsx:16',
    'dynamic router.push app/index.tsx -> null null app/index.tsx:17',
    'dynamic router.push app/index.tsx -> null null app/index.tsx:18',
    'dynamic router.push app/index.tsx -> null null app/index.tsx:19',
    'literal Link app/index.tsx -> app/a.tsx /a app/index.tsx:22',
    'literal Link app/index.tsx -> app/b.tsx /b app/index.tsx:23',
    'literal Link app/index.tsx -> app/c.tsx /c app/index.tsx:24',
    'literal Link app/index.tsx -> null /missing app/index.tsx:28',
    'literal Link app/two.tsx -> app/a.tsx /a app/two.tsx:2',
    'literal Link app/two.tsx -> app/b.tsx /b app/two.tsx:2',
    'literal router.navigate app/index.tsx -> app/b.tsx /b app/index.tsx:10',
    'literal router.navigate app/index.tsx -> app/c.tsx /c app/index.tsx:14',
    'literal router.push app/index.tsx -> app/a.tsx /a app/index.tsx:15',
    'literal router.push app/index.tsx -> app/a.tsx /a app/index.tsx:20',
    'literal router.push app/index.tsx -> app/a.tsx /a app/index.tsx:9',
    'literal router.push app/index.tsx -> app/c.tsx /c app/index.tsx:11',
    'literal router.replace app/index.tsx -> app/trip/[id].tsx /trip/[*] app/index.tsx:13',
    'literal router.replace app/index.tsx -> app/trip/[id].tsx /trip/[id] app/index.tsx:12',
  ]);
  assert.equal(report.summary.dynamicEdges, 7);
  assert.deepEqual(report.routes.map(node => [node.route, node.unlinked]), [['/a', false], ['/b', false], ['/c', false], ['/', false], ['/trip/[id]', false], ['/two', true]]);
  assert.equal(normalizeTarget('../x/./y//?q#h', '/a/b/c'), '/a/x/y');
  assert.equal(normalizeTarget('./article', '/blog/post'), '/blog/article');
  assert.equal(normalizeTarget('(group)/page', '/'), '/page');
  const routes = [{ kind: 'route', route: '/trip/[id]' }, { kind: 'route', route: '/trip/new' }, { kind: 'route', route: '/[...rest]' }, { kind: 'route', route: '/+not-found' }];
  assert.equal(matchRoute('/trip/new', routes).route, '/trip/new');
  assert.equal(matchRoute('/trip/42', routes).route, '/trip/[id]');
  assert.equal(matchRoute('/trip/[*]', routes).route, '/trip/[id]');
  assert.equal(matchRoute('/anything/at/all', routes).route, '/[...rest]');
  assert.equal(matchRoute('/+not-found', routes).route, '/[...rest]');
  assert.equal(matchRoute('/', routes), null);
});

test('registers screens from layouts, lets Tabs and Drawer reach every child, and flags routes nothing leads to', async t => {
  const f = await fixture(t);
  await f.put('app/_layout.tsx', `import { Stack } from 'expo-router';
export default function Root() { return <Stack><Stack.Screen name="(tabs)" /><Stack.Screen name="trip/[id]" options={{ title: 'Trip' }} /><Stack.Screen name="nowhere" /></Stack>; }
`);
  await f.put('app/(tabs)/_layout.tsx', `import { Tabs } from 'expo-router';
export default () => <Tabs><Tabs.Screen name="index" /><Tabs.Screen name="home" /></Tabs>;
`);
  await f.put('app/drawer/_layout.tsx', "import { Drawer } from 'expo-router/drawer';\nexport default () => <Drawer><Drawer.Screen name=\"one\" /></Drawer>;\n");
  await f.put('app/slot/_layout.tsx', "import { Slot } from 'expo-router';\nexport default () => <Slot />;\n");
  await f.put('app/stack/_layout.tsx', "import { Stack } from 'expo-router';\nexport default () => <Stack />;\n");
  for (const file of ['app/(tabs)/index.tsx', 'app/(tabs)/home.tsx', 'app/(tabs)/other.tsx', 'app/trip/[id].tsx', 'app/orphan.tsx', 'app/+not-found.tsx', 'app/drawer/one.tsx', 'app/drawer/two.tsx', 'app/slot/lonely.tsx', 'app/stack/index.tsx', 'app/stack/second.tsx']) await f.put(file, screen);
  const report = await f.scan();
  assert.deepEqual(edgesOf(report), [
    'navigator Drawer app/drawer/_layout.tsx -> app/drawer/two.tsx /drawer/two app/drawer/_layout.tsx:2',
    'navigator Stack app/stack/_layout.tsx -> app/stack/index.tsx /stack app/stack/_layout.tsx:2',
    'navigator Tabs app/(tabs)/_layout.tsx -> app/(tabs)/other.tsx /other app/(tabs)/_layout.tsx:2',
    'screen Drawer.Screen app/drawer/_layout.tsx -> app/drawer/one.tsx /drawer/one app/drawer/_layout.tsx:2',
    'screen Stack.Screen app/_layout.tsx -> app/(tabs)/_layout.tsx / app/_layout.tsx:2',
    'screen Stack.Screen app/_layout.tsx -> app/trip/[id].tsx /trip/[id] app/_layout.tsx:2',
    'screen Stack.Screen app/_layout.tsx -> null nowhere app/_layout.tsx:2',
    'screen Tabs.Screen app/(tabs)/_layout.tsx -> app/(tabs)/home.tsx /home app/(tabs)/_layout.tsx:2',
    'screen Tabs.Screen app/(tabs)/_layout.tsx -> app/(tabs)/index.tsx / app/(tabs)/_layout.tsx:2',
  ]);
  assert.deepEqual(report.routes.filter(node => node.kind === 'route').map(node => [node.route, node.unlinked]), [
    ['/home', false], ['/', false], ['/other', false], ['/+not-found', false], ['/drawer/one', false], ['/drawer/two', false], ['/orphan', true], ['/slot/lonely', true], ['/stack', false], ['/stack/second', true], ['/trip/[id]', false],
  ]);
  assert.deepEqual(report.routes.filter(node => node.kind === 'layout').map(node => [node.file, node.navigators, node.layout]), [
    ['app/(tabs)/_layout.tsx', ['Tabs'], 'app/_layout.tsx'], ['app/_layout.tsx', ['Stack'], null], ['app/drawer/_layout.tsx', ['Drawer'], 'app/_layout.tsx'],
    ['app/slot/_layout.tsx', ['Slot'], 'app/_layout.tsx'], ['app/stack/_layout.tsx', ['Stack'], 'app/_layout.tsx'],
  ]);
  assert.equal(report.summary.unlinkedRoutes, 3);
  const mermaid = formatMermaid(report);
  const id = file => `n${report.routes.findIndex(node => node.file === file)}`;
  assert.ok(mermaid.startsWith('flowchart LR\n'));
  assert.ok(mermaid.includes(`  ${id('app/orphan.tsx')}["/orphan (unlinked)"]:::flagged\n`));
  assert.ok(mermaid.includes(`  ${id('app/_layout.tsx')}[["/ layout"]]:::layout\n`));
  assert.ok(mermaid.includes(`  ${id('app/_layout.tsx')} --- ${id('app/trip/[id].tsx')}\n`));
  assert.ok(mermaid.includes(`  ${id('app/_layout.tsx')} --- x0["nowhere (no route)"]:::flagged\n`));
  assert.ok(mermaid.includes('  p0("travel.coast (no route)"):::flagged\n'));
});

test('attributes generated symbols to routes through imported bindings, within three files, and lists quoted keys as mentions', async t => {
  const f = await fixture(t);
  await f.put('app/_layout.tsx', "import { Slot } from 'expo-router';\nexport default () => <Slot />;\n");
  await f.put('app/index.tsx', `import { Hero } from '../components';
import { colors } from '../components/Theme';
import * as Lab from '../components/Lab';
import { Far } from '@/components/far/A';
const keys = ['travel.coast', 'tasks.garden'];
export default function Index() { return <><Hero tint={colors.ink} /><Lab.Pill /><Far /></>; }
`);
  await f.put('app/connect.tsx', "import { colors } from '../components/Theme';\nexport default function Connect() { return colors; }\n");
  await f.put('app/other.tsx', "import { Nav } from '../components/Theme';\nexport default () => <Nav />;\n");
  await f.put('app/travel.tsx', "export { default } from '../screens/Travel';\n");
  await f.put('components/index.ts', "import { Hero } from './Hero';\nexport { Hero };\n");
  await f.put('components/Hero.tsx', "import { AppAssets } from '../assets.generated';\nexport function Hero() { return <Img asset={AppAssets.Travel.coast} />; }\n");
  await f.put('components/Theme.tsx', "import { useRouter } from 'expo-router';\nexport const colors = { ink: '#000' };\nexport function Nav() { const router = useRouter(); router.push('/connect'); return null; }\n");
  await f.put('components/Lab.tsx', "import { useRouter } from 'expo-router';\nexport function Pill() { useRouter().navigate('/connect'); return null; }\n");
  await f.put('screens/Travel.tsx', `import { AppAssets } from '../assets.generated';
import { Pill } from '../components/Lab';
function Save() { return <Img asset={AppAssets.Tasks.garden} />; }
export default function Travel() { return <><Save /><Pill /></>; }
`);
  await f.put('components/far/A.tsx', "export { Far } from './B';\n");
  await f.put('components/far/B.tsx', "import { C } from './C';\nexport function Far() { return <C />; }\n");
  await f.put('components/far/C.tsx', "import { D } from './D';\nimport { AppAssets } from '../../assets.generated';\nexport function C() { return <D asset={AppAssets.Hero.art} />; }\n");
  await f.put('components/far/D.tsx', "import { AppAssets } from '../../assets.generated';\nexport function D() { return AppAssets.Travel.coast; }\n");
  await f.put('components/Unused.tsx', "import { AppAssets } from '../assets.generated';\nexport const unused = AppAssets.Tasks.garden;\n");
  await f.put('assets.generated.ts', 'export const AppAssets = { Travel: { coast: { key: "travel.coast" } }, Tasks: { garden: { key: "tasks.garden" } }, Hero: { art: { key: "hero.art" } } } as const;\n');
  const report = await f.scan();
  assert.equal(report.partial, false, JSON.stringify(report.issues));
  assert.deepEqual(placementsOf(routeOfFile(report, 'app/index.tsx')), [
    'hero.art components/far/C.tsx:3 via components/far/A.tsx>components/far/B.tsx>components/far/C.tsx',
    'travel.coast components/Hero.tsx:2 via components/index.ts>components/Hero.tsx',
  ]);
  assert.deepEqual(placementsOf(routeOfFile(report, 'app/travel.tsx')), ['tasks.garden screens/Travel.tsx:3 via screens/Travel.tsx']);
  assert.deepEqual(placementsOf(routeOfFile(report, 'app/connect.tsx')), []);
  assert.deepEqual(edgesOf(report), [
    // connect.tsx imports only `colors` from Theme, so Nav's push is not its own edge; index reaches Pill through the namespace.
    'literal router.navigate app/index.tsx -> app/connect.tsx /connect components/Lab.tsx:2 via components/Lab.tsx',
    'literal router.navigate app/travel.tsx -> app/connect.tsx /connect components/Lab.tsx:2 via screens/Travel.tsx>components/Lab.tsx',
    'literal router.push app/other.tsx -> app/connect.tsx /connect components/Theme.tsx:3 via components/Theme.tsx',
  ]);
  assert.deepEqual(report.placements, [
    { key: 'travel.coast', routes: ['/'], layouts: [] },
    { key: 'tasks.garden', routes: ['/travel'], layouts: [] },
    { key: 'hero.art', routes: ['/'], layouts: [] },
  ]);
  assert.deepEqual(report.mentions, [{ key: 'tasks.garden', line: 5, file: 'app/index.tsx' }, { key: 'travel.coast', line: 5, file: 'app/index.tsx' }]);
  // D is four files from the route, and Unused is imported by nothing.
  assert.deepEqual(report.unattributed, [{ key: 'tasks.garden', line: 2, file: 'components/Unused.tsx' }, { key: 'travel.coast', line: 2, file: 'components/far/D.tsx' }]);
  assert.deepEqual(report.summary, { routes: 4, layouts: 1, edges: 3, dynamicEdges: 0, unlinkedRoutes: 2, references: 5, mentions: 2, unattributed: 2, unroutedPlacements: 0 });
  assert.deepEqual(report.routes.filter(node => node.unlinked).map(node => node.route), ['/other', '/travel']);
  assert.equal(JSON.stringify(report).includes('#000'), false);
  // --src narrows attribution and the reference scan to the given directories; the app directory is always included.
  const narrow = await f.scan({ src: [path.join(f.root, 'screens')] });
  assert.deepEqual(placementsOf(routeOfFile(narrow, 'app/index.tsx')), []);
  assert.deepEqual(placementsOf(routeOfFile(narrow, 'app/travel.tsx')), ['tasks.garden screens/Travel.tsx:3 via screens/Travel.tsx']);
  assert.deepEqual(narrow.unattributed, []);
  assert.deepEqual(edgesOf(narrow), []);
});

test('a layout shows its own placements, and a component that imports nothing relevant credits nothing', async t => {
  const f = await fixture(t);
  await f.put('app/_layout.tsx', "import { Slot } from 'expo-router';\nimport { Brand } from '../components/Brand';\nexport default () => <><Brand /><Slot /></>;\n");
  await f.put('app/index.tsx', screen);
  await f.put('components/Brand.tsx', "import { AppAssets } from '../assets.generated';\nconst art = AppAssets.Hero.art;\nexport function Brand() { return <Img asset={art} />; }\nexport function Other() { return AppAssets.Travel.coast; }\n");
  await f.put('assets.generated.ts', 'export const AppAssets = {};\n');
  const report = await f.scan();
  assert.deepEqual(placementsOf(routeOfFile(report, 'app/_layout.tsx')), ['hero.art components/Brand.tsx:2 via components/Brand.tsx']);
  assert.deepEqual(report.placements.map(item => [item.key, item.routes, item.layouts]), [['travel.coast', [], []], ['tasks.garden', [], []], ['hero.art', [], ['app/_layout.tsx']]]);
  assert.deepEqual(report.unattributed, [{ key: 'travel.coast', line: 4, file: 'components/Brand.tsx' }]);
  assert.equal(report.summary.unroutedPlacements, 2);
  assert.ok(formatMermaid(report).includes(' -.- p2\n'));
});

test('enforces the per-file, total-byte, file-count and depth budgets and reports a partial scan', async t => {
  const f = await fixture(t);
  await f.put('app/index.tsx', screen);
  await f.put('app/big.tsx', screen.padEnd(LIMITS.fileBytes + 1, ' '));
  const oversized = await f.scan();
  assert.equal(oversized.partial, true);
  assert.equal(new Set(oversized.issues.map(issue => JSON.stringify(issue))).size, oversized.issues.length);
  assert.ok(oversized.issues.some(issue => issue.path === 'app/big.tsx' && issue.reason === 'source_unreadable_or_byte_limit'), JSON.stringify(oversized.issues));
  assert.deepEqual(oversized.routes.map(node => node.route), ['/big', '/']);
  await rm(path.join(f.root, 'app/big.tsx'));

  const padded = screen.padEnd(LIMITS.fileBytes, ' ');
  for (let index = 0; index < 9; index++) await f.put(`app/bytes/${index}.tsx`, padded);
  const totalBytes = await f.scan();
  assert.ok(totalBytes.issues.some(issue => issue.path === 'app/bytes/8.tsx' && issue.reason === 'source_unreadable_or_byte_limit'), JSON.stringify(totalBytes.issues));
  assert.equal(totalBytes.routes.length, 10);
  await rm(path.join(f.root, 'app/bytes'), { recursive: true });

  await Promise.all(Array.from({ length: LIMITS.files }, (_, index) => f.put(`app/many/${String(index).padStart(3, '0')}.tsx`, screen)));
  const files = await f.scan();
  assert.equal(files.routes.length, LIMITS.files);
  assert.ok(files.issues.some(issue => issue.path === 'app/many/499.tsx' && issue.reason === 'source_file_limit'), JSON.stringify(files.issues));
  await rm(path.join(f.root, 'app/many'), { recursive: true });

  await f.put(`app/${Array.from({ length: LIMITS.depth + 1 }, () => 'd').join('/')}/deep.tsx`, screen);
  const depth = await f.scan();
  assert.ok(depth.issues.some(issue => issue.reason === 'depth_limit'));
  assert.equal(depth.partial, true);
});

test('ignores links to other apps and sites, a Link or router the file declares itself, and a router from another package', async t => {
  const f = await fixture(t);
  await f.put('app/[...rest].tsx', screen);
  await f.put('app/index.tsx', "import { Link } from 'expo-router';\nexport default () => <><Link href=\"https://expo.dev/docs\" /><Link href=\"mailto:a@b.co\" /><Link href=\"//cdn.example.com/x\" /><Link href=\"/deep/path\" /></>;\n");
  await f.put('app/local.tsx', "const Link = () => null;\nconst router = { push: () => {} };\nexport default () => { router.push('/deep/x'); return <Link href=\"/deep/y\" />; };\n");
  await f.put('app/other.tsx', "import { router } from 'other-lib';\nexport default () => { router.push('/deep/z'); return null; };\n");
  await f.put('app/param.tsx', "export default function Param({ router }) { router.push('/deep/w'); return null; }\n");
  const report = await f.scan();
  assert.deepEqual(edgesOf(report), [
    'literal Link app/index.tsx -> app/[...rest].tsx /deep/path app/index.tsx:2',
    'literal router.push app/param.tsx -> app/[...rest].tsx /deep/w app/param.tsx:1',
  ]);
  for (const text of ['expo.dev', 'a@b.co', 'cdn.example', '/deep/x', '/deep/y', '/deep/z']) assert.equal(JSON.stringify(report).includes(text), false, text);
});

test('resolves the @/ alias from tsconfig.json, or to src beside src/app', async t => {
  const f = await fixture(t);
  await f.put('src/app/index.tsx', "import { Hero } from '@/components/Hero';\nexport default () => <Hero />;\n");
  await f.put('src/components/Hero.tsx', "import { AppAssets } from '../assets.generated';\nexport function Hero() { return AppAssets.Travel.coast; }\n");
  await f.put('components/Hero.tsx', "import { AppAssets } from '../src/assets.generated';\nexport function Hero() { return AppAssets.Tasks.garden; }\n");
  await f.put('src/assets.generated.ts', 'export const AppAssets = {};\n');
  const bySrc = await f.scan();
  assert.deepEqual(placementsOf(routeOfFile(bySrc, 'src/app/index.tsx')), ['travel.coast src/components/Hero.tsx:2 via src/components/Hero.tsx']);
  await f.put('tsconfig.json', '{\n  // Expo template\n  "extends": "expo/tsconfig.base",\n  "compilerOptions": { "paths": { "@/*": ["./*"] } },\n}\n');
  const byTsconfig = await f.scan({ src: [f.root] });
  assert.deepEqual(placementsOf(routeOfFile(byTsconfig, 'src/app/index.tsx')), ['tasks.garden components/Hero.tsx:2 via components/Hero.tsx']);
  assert.equal(byTsconfig.partial, false, JSON.stringify(byTsconfig.issues));
});

test('follows no symlink and parses nothing outside the root', async t => {
  const f = await fixture(t);
  const outside = await fixture(t);
  await outside.put('Secret.tsx', "import { AppAssets } from './assets.generated';\nexport function Secret() { return AppAssets.Travel.coast; }\n");
  await f.put('app/index.tsx', "import { Secret } from '../linked/Secret';\nimport { Up } from '../../Up';\nexport default () => <><Secret /><Up /></>;\n");
  await symlink(outside.root, path.join(f.root, 'linked'));
  const report = await f.scan();
  assert.deepEqual(report.routes[0].placements, []);
  assert.deepEqual(report.unattributed, []);
  // The linked file is found by name, refused on read, and reported; its contents never enter the report.
  assert.deepEqual(report.issues, [{ path: 'linked/Secret.tsx', reason: 'symlink_or_outside_root' }]);
  assert.equal(report.partial, true);
  assert.equal(JSON.stringify(report).includes('AppAssets'), false);
});

test('the command prints JSON or Mermaid, validates its options, and exits 2 on a partial scan', async t => {
  const f = await fixture(t);
  await f.put('app/index.tsx', "import { Link } from 'expo-router';\nexport default () => <Link href=\"/about\" />;\n");
  await f.put('app/about.tsx', screen);
  const json = await f.run([], true);
  assert.equal(json.code, 0);
  assert.equal(json.stderr, '');
  assert.equal(json.report.schemaVersion, 1);
  assert.deepEqual(edgesOf(json.report), ['literal Link app/index.tsx -> app/about.tsx /about app/index.tsx:2']);
  assert.deepEqual(await f.run(['--format', 'json'], true), json);
  const mermaid = await f.run(['--format', 'mermaid']);
  assert.equal(mermaid.code, 0);
  assert.equal(mermaid.stdout, formatMermaid(json.report));
  assert.ok(mermaid.stdout.includes('  n1 --> n0\n'));
  const svg = await f.run(['--format', 'svg']);
  assert.deepEqual(svg, { code: 1, stdout: '', stderr: 'Assetlib: --format must be json or mermaid.\n' });
  assert.deepEqual(JSON.parse((await f.run(['--format', 'svg', '--json'])).stdout), { error: '--format must be json or mermaid.' });
  assert.match((await f.run(['--apply'])).stderr, /Unknown option/);
  assert.match((await f.run(['--app'])).stderr, /--app requires a value/);
  let help = '';
  assert.equal(await main(['map', '--help'], {}, { stdout: { write: text => { help += text; } }, stderr: { write() {} } }), 0);
  assert.match(help, /assetlib map --catalog <path> \[--app <dir>\] \[--root <dir>\] \[--src <dir>\]\.\.\. \[--format json\|mermaid\] \[--json\]/);
  let missing = '';
  assert.equal(await main(['map'], {}, { stdout: { write() {} }, stderr: { write: text => { missing += text; } } }), 1);
  assert.equal(missing, 'Assetlib: --catalog is required.\n');

  await f.put('app/big.tsx', screen.padEnd(LIMITS.fileBytes + 1, ' '));
  const partial = await f.run([], true);
  assert.equal(partial.code, 2);
  assert.equal(partial.report.partial, true);
  assert.match(partial.stderr, /^Route scan was partial; routes, edges and references may be missing\.\n  app\/big\.tsx: source_unreadable_or_byte_limit\n/);
  const partialJson = await f.run(['--json', '--format', 'mermaid']);
  assert.equal(partialJson.code, 2);
  assert.ok(partialJson.stdout.startsWith('flowchart LR\n'));
  assert.equal(JSON.parse(partialJson.stderr).warning, 'Route scan was partial; routes, edges and references may be missing.');
});
