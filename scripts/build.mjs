import { build } from 'esbuild';
import { mkdir, readFile, rm, copyFile, access, readdir, lstat, realpath } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { DEFAULT_BUILT_IN_SOUNDS } from '../src/shared/sounds.ts';

assert.ok(process.argv.slice(2).every(arg => arg === '--release'), 'Only --release is supported');
const release = process.argv.includes('--release');
const outdir = release ? 'release' : 'dist';
const debug = !release && process.env.DONEBELL_DEBUG === '1';
const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
const metadata = JSON.parse(await readFile('package.json', 'utf8'));
const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
assert.equal(manifest.version, metadata.version);
assert.equal(lock.version, metadata.version);
assert.equal(lock.packages[''].version, metadata.version);
const archive = `donebell-v${manifest.version}.zip`;

// Release builds never read assets/sounds/ or touch the local dist/ directory.
// Local builds keep every available packaged sound, with no unplayable labels.
const catalog = [...DEFAULT_BUILT_IN_SOUNDS];
const soundDirectory = resolve('assets/sounds');
async function readLocalCatalog() {
  const catalogPath = resolve(soundDirectory, 'local-catalog.json');
  let stat;
  try {
    stat = await lstat(catalogPath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return [];
  }
  assert.ok(stat.isFile(), 'Local catalog must be a regular file, not a symlink');
  assert.equal(await realpath(soundDirectory), soundDirectory, 'Local sounds directory must not use symlinks');
  assert.ok(stat.size <= 256 * 1024, 'Local catalog exceeds 256 KiB');
  const entries = JSON.parse(await readFile(catalogPath, 'utf8'));
  assert.ok(Array.isArray(entries) && entries.length <= 1000, 'Local catalog must be an array of at most 1000 entries');
  const ids = new Set([...catalog.map(sound => sound.id), 'custom']);
  const filenames = new Set();
  // Validate every entry before accessing any audio or changing build output.
  for (const sound of entries) {
    assert.ok(sound && typeof sound === 'object' && !Array.isArray(sound), 'Invalid local sound entry');
    assert.deepEqual(Object.keys(sound).sort(), ['file', 'id', 'name'], 'Local entries require exactly id, name, and file');
    assert.ok(typeof sound.id === 'string' && sound.id.length <= 64 &&
      /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(sound.id) && !/[^a-z0-9-]/.test(sound.id), 'Invalid local sound ID');
    assert.ok(!ids.has(sound.id), 'Duplicate or reserved local sound ID');
    assert.ok(typeof sound.name === 'string' && sound.name.length >= 1 && sound.name.length <= 80 &&
      sound.name === sound.name.trim() && !/[\u0000-\u001f\u007f-\u009f]/.test(sound.name), 'Invalid local sound name');
    assert.ok(typeof sound.file === 'string' && sound.file.length <= 128 &&
      /^[a-z0-9]+(?:-[a-z0-9]+)*\.mp3$/.test(sound.file) && sound.file === sound.file.trim(),
    'Local sound filenames must be plain lowercase MP3 basenames');
    assert.ok(!filenames.has(sound.file), 'Duplicate local sound filename');
    ids.add(sound.id);
    filenames.add(sound.file);
  }
  return entries;
}

// Do not even open the optional catalog in public builds.
if (!release) {
  for (const sound of await readLocalCatalog()) {
    try {
      const stat = await lstat(resolve(soundDirectory, sound.file));
      assert.ok(stat.isFile(), 'Local audio must be a regular file, not a symlink');
      catalog.push(sound);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      console.warn(`Warning: assets/sounds/${sound.file} is missing; omitted from the built-in sound list.`);
    }
  }
}

if (release) await rm(archive, { force: true });
await rm(outdir, { recursive: true, force: true });
await mkdir(`${outdir}/offscreen`, { recursive: true });
await mkdir(`${outdir}/popup`, { recursive: true });
await mkdir(`${outdir}/assets/icons`, { recursive: true });
const result = await build({
  entryPoints: ['src/content/index.ts', 'src/background/index.ts', 'src/offscreen/index.ts', 'src/popup/index.ts'],
  outbase: 'src',
  outdir,
  bundle: true,
  format: 'iife',
  target: 'chrome116',
  logLevel: 'info',
  legalComments: 'eof',
  minify: release,
  sourcemap: false,
  define: {
    __DONEBELL_DEBUG__: JSON.stringify(debug),
    __DONEBELL_BUILT_IN_SOUNDS__: JSON.stringify(catalog),
  },
  metafile: true,
});
for (const output of Object.values(result.metafile.outputs)) {
  assert.equal(output.imports.length, 0, 'Runtime bundles must be self-contained');
}
await copyFile('manifest.json', `${outdir}/manifest.json`);
await copyFile('src/offscreen/offscreen.html', `${outdir}/offscreen/offscreen.html`);
await copyFile('src/popup/popup.html', `${outdir}/popup/popup.html`);
await copyFile('src/popup/popup.css', `${outdir}/popup/popup.css`);
await copyFile('LICENSE', `${outdir}/LICENSE`);
await copyFile('THIRD_PARTY_NOTICES.md', `${outdir}/THIRD_PARTY_NOTICES.md`);

const icons = [...new Set([...Object.values(manifest.icons), ...Object.values(manifest.action.default_icon)])];
assert.deepEqual(manifest.action.default_icon, manifest.icons);
for (const [size, file] of Object.entries(manifest.icons)) {
  assert.equal(file, `assets/icons/icon${size}.png`);
  const png = await readFile(file);
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(png.readUInt32BE(16), Number(size));
  assert.equal(png.readUInt32BE(20), Number(size));
}
for (const file of icons) await copyFile(file, `${outdir}/${file}`);

const packagedSounds = [];
for (const sound of catalog) {
  if (!sound.file) continue;
  await mkdir(`${outdir}/sounds`, { recursive: true });
  await copyFile(`assets/sounds/${sound.file}`, `${outdir}/sounds/${sound.file}`);
  packagedSounds.push(`sounds/${sound.file}`);
}

// Static artifact checks only; no tests or browser automation are run here.
assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.minimum_chrome_version, '116');
assert.deepEqual(manifest.permissions, ['offscreen', 'storage']);
assert.equal(manifest.host_permissions, undefined);
assert.equal(manifest.optional_permissions, undefined);
assert.equal(manifest.web_accessible_resources, undefined);
assert.equal(manifest.externally_connectable, undefined);
assert.match(manifest.content_security_policy.extension_pages, /connect-src 'none'/);
assert.equal(manifest.action.default_popup, 'popup/popup.html');
assert.deepEqual(manifest.content_scripts.map(script => script.matches), [['https://chatgpt.com/*']]);
const files = ['manifest.json', manifest.background.service_worker,
  ...manifest.content_scripts.flatMap(script => script.js),
  'offscreen/offscreen.html', 'offscreen/index.js',
  manifest.action.default_popup, 'popup/index.js', 'popup/popup.css',
  'LICENSE', 'THIRD_PARTY_NOTICES.md', ...icons, ...packagedSounds].sort();
assert.match(await readFile(`${outdir}/offscreen/offscreen.html`, 'utf8'), /src="index\.js"/);
const popupHtml = await readFile(`${outdir}/popup/popup.html`, 'utf8');
assert.match(popupHtml, /src="index\.js"/);
assert.match(popupHtml, /href="popup\.css"/);
assert.doesNotMatch(popupHtml, /<script>|https?:\/\//, 'Popup must not use inline or remote resources');
await Promise.all(files.map(file => access(`${outdir}/${file}`)));
async function listFiles(directory, prefix = '') {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = `${prefix}${entry.name}`;
    if (entry.isDirectory()) files.push(...await listFiles(`${directory}/${entry.name}`, `${name}/`));
    else {
      assert.ok(entry.isFile(), `Unexpected non-file: ${name}`);
      files.push(name);
    }
  }
  return files.sort();
}
assert.deepEqual(await listFiles(outdir), files, 'Only declared extension resources belong in the build');
console.log(`Verified ${outdir}/: MV3, permissions, icons, runtime paths, ${catalog.length} built-in sounds, debug=${debug}.`);

if (release) {
  assert.deepEqual(catalog, DEFAULT_BUILT_IN_SOUNDS);
  assert.equal(packagedSounds.length, 0);
  for (const file of files) {
    assert.doesNotMatch(file, /\.(?:mp3|wav|ogg|map|zip)$/i);
    if (!file.endsWith('.js')) continue;
    const script = await readFile(`${outdir}/${file}`, 'utf8');
    assert.doesNotMatch(script, /console\.debug|sourceMappingURL|\.mp3/i);
  }
  // Explicit file allowlist, no enclosing directory and no macOS extra fields.
  execFileSync('zip', ['-X', '-q', resolve(archive), ...files], { cwd: outdir });
  const entries = execFileSync('unzip', ['-Z1', archive], { encoding: 'utf8' }).trim().split('\n').sort();
  assert.deepEqual(entries, files, 'Inspect every ZIP entry against the complete runtime allowlist');
  for (const file of entries) {
    const archived = execFileSync('unzip', ['-p', archive, file]);
    assert.deepEqual(archived, await readFile(`${outdir}/${file}`), `ZIP content differs: ${file}`);
  }
  console.log(`Created ${archive}; all ${entries.length} ZIP entries and their contents verified.`);
}
