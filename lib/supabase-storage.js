'use strict';

/**
 * Legacy shim — kept under this name so every existing
 * `require('../lib/supabase-storage')` keeps working without touching
 * 30+ call sites. All persistence goes to Cloudflare R2 now; there is
 * no Supabase backend any more.
 *
 * If you're writing new code, import `./r2-storage` directly.
 */

module.exports = require('./r2-storage');
