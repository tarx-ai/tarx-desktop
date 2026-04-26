'use strict';

/**
 * afterSign hook — runs after electron-builder signs the app.
 * Submits to Apple notarytool and staples.
 *
 * Env vars required (set in CI or local shell before running `npm run publish`):
 *   APPLE_ID           — john@tarx.com (or whichever Apple ID owns the cert)
 *   APPLE_APP_PASSWORD — app-specific password from appleid.apple.com
 *   APPLE_TEAM_ID      — JH4243GARF
 */

const { notarize } = require('@electron/notarize');

exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== 'darwin') return;

  const appName = context.packager.appInfo.productFilename;
  const appPath = `${appOutDir}/${appName}.app`;

  const appleId        = process.env.APPLE_ID;
  const appleIdPassword = process.env.APPLE_APP_PASSWORD;
  const teamId         = process.env.APPLE_TEAM_ID || 'JH4243GARF';

  if (!appleId || !appleIdPassword) {
    console.warn('[notarize] APPLE_ID / APPLE_APP_PASSWORD not set — skipping notarization');
    return;
  }

  console.log(`[notarize] Submitting ${appPath} to notarytool…`);

  await notarize({
    tool: 'notarytool',
    appPath,
    appleId,
    appleIdPassword,
    teamId,
  });

  console.log('[notarize] Done.');
};
