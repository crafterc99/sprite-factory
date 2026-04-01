#!/usr/bin/env node
/**
 * Backfill existing assets to Supabase Storage.
 *
 * Run once after setting up Supabase to migrate all current PNGs:
 *   SUPABASE_URL=... SUPABASE_SERVICE_KEY=... node scripts/backfill-supabase.js
 *
 * Uploads only files matching: portraits, angles, headshots, sprite sheets.
 * Skips raw-sprites/ and working directories (those are transient).
 */

'use strict';

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const { isAvailable, uploadFile } = require('../lib/supabase-storage');

if (!isAvailable()) {
  console.error('ERROR: Set SUPABASE_URL and SUPABASE_SERVICE_KEY before running this script.');
  process.exit(1);
}

const ASSETS_DIR = path.join(__dirname, '../data/assets');
const files = fs.readdirSync(ASSETS_DIR).filter(f => f.endsWith('.png') || f.endsWith('.jpg') || f.endsWith('.webp'));

console.log(`Found ${files.length} asset files. Uploading to Supabase…\n`);

let done = 0, failed = 0;

(async () => {
  for (const file of files) {
    const filePath = path.join(ASSETS_DIR, file);
    try {
      await uploadFile(file, filePath);
      done++;
      if (done % 10 === 0) process.stdout.write(`  ${done}/${files.length} uploaded\r`);
    } catch (e) {
      console.warn(`  FAILED: ${file} — ${e.message}`);
      failed++;
    }
  }
  console.log(`\n✓ Done. ${done} uploaded, ${failed} failed.`);
})();
