import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';

const MAX_WIDTH = 1600;
const JPEG_QUALITY = 82;

export async function savePhoto(buffer, assignmentId, rootDir = './uploads') {
  let processed;
  try {
    processed = await sharp(buffer)
      .rotate()
      .resize({ width: MAX_WIDTH, withoutEnlargement: true })
      .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
      .toBuffer();
  } catch (e) {
    throw new Error(`Invalid image: ${e.message}`);
  }

  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dir = join(rootDir, `${yyyy}-${mm}`);
  mkdirSync(dir, { recursive: true });

  const path = join(dir, `${assignmentId}.jpg`);
  writeFileSync(path, processed);
  return path;
}

export function photoRelPath(absPath) {
  const idx = absPath.indexOf('uploads/');
  return idx === -1 ? absPath : absPath.slice(idx);
}
