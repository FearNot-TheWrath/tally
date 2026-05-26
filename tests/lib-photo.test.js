import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { savePhoto } from '../src/lib/photo.js';

async function makeJpeg() {
  // 800x600 plain red, with a fake EXIF tag we expect to be stripped.
  return await sharp({
    create: { width: 800, height: 600, channels: 3, background: { r: 255, g: 0, b: 0 } },
  })
    .withMetadata({ exif: { IFD0: { Software: 'TallyTest' } } })
    .jpeg().toBuffer();
}

test('savePhoto writes a resized JPEG to uploads/YYYY-MM/<id>.jpg and strips EXIF', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tally-photos-'));
  try {
    const buf = await makeJpeg();
    const path = await savePhoto(buf, 42, root);

    assert.ok(existsSync(path), 'file should be on disk');
    assert.match(path, /\d{4}-\d{2}\/42\.jpg$/);

    const meta = await sharp(path).metadata();
    assert.ok(meta.width <= 1600, 'should be resized to <= 1600 wide');
    assert.equal(meta.exif, undefined, 'EXIF should be stripped');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('savePhoto rejects non-image buffers', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tally-photos-'));
  try {
    await assert.rejects(
      () => savePhoto(Buffer.from('not an image'), 1, root),
      /Invalid image/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
