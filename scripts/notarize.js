'use strict';

/**
 * afterSign hook — runs after electron-builder signs the app.
 * Submits to Apple notarytool and staples.
 *
 * Env vars required (set in CI or local shell before running a release build):
 * Preferred:
 *   APPLE_API_KEY           — App Store Connect API key path or key contents
 *   APPLE_API_KEY_ID        — App Store Connect API key id
 *   APPLE_API_ISSUER        — App Store Connect issuer id, when required
 *
 * Also supported:
 *   APPLE_KEYCHAIN_PROFILE  — notarytool keychain profile, defaults to "tarx"
 *   APPLE_KEYCHAIN          — optional keychain path/name for that profile
 *
 * Fallback:
 *   APPLE_ID               — john@tarx.com (or whichever Apple ID owns the cert)
 *   APPLE_APP_PASSWORD     — app-specific password from appleid.apple.com
 *   APPLE_TEAM_ID          — JH4243GARF
 */

const { notarize } = require('@electron/notarize');

exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== 'darwin') return;

  const appName = context.packager.appInfo.productFilename;
  const appPath = `${appOutDir}/${appName}.app`;

  if (process.env.APPLE_SKIP_NOTARIZE === '1') {
    console.warn('[notarize] APPLE_SKIP_NOTARIZE=1 — skipping notarization');
    return;
  }

  const appleApiKey = process.env.APPLE_API_KEY;
  const appleApiKeyId = process.env.APPLE_API_KEY_ID;
  const appleApiIssuer = process.env.APPLE_API_ISSUER;
  const appleId = process.env.APPLE_ID;
  const appleIdPassword = process.env.APPLE_APP_PASSWORD || process.env.APPLE_APP_SPECIFIC_PASSWORD;
  const teamId = process.env.APPLE_TEAM_ID || 'JH4243GARF';
  const keychain = process.env.APPLE_KEYCHAIN;
  const keychainProfile = process.env.APPLE_KEYCHAIN_PROFILE || (!appleApiKey && !appleApiKeyId && !appleId && !appleIdPassword ? 'tarx' : '');

  console.log(`[notarize] Submitting ${appPath} to notarytool…`);

  const credentialModes = [
    appleApiKey || appleApiKeyId ? 'api-key' : '',
    keychainProfile ? 'keychain-profile' : '',
    appleId || appleIdPassword ? 'apple-id-password' : '',
  ].filter(Boolean);

  if (credentialModes.length !== 1) {
    throw new Error(`[notarize] Expected exactly one credential mode, found ${credentialModes.length || 0}. Set APPLE_API_KEY/APPLE_API_KEY_ID, APPLE_KEYCHAIN_PROFILE, or APPLE_ID/APPLE_APP_PASSWORD.`);
  }

  let credentials;
  if (appleApiKey || appleApiKeyId) {
    if (!appleApiKey || !appleApiKeyId) {
      throw new Error('[notarize] APPLE_API_KEY and APPLE_API_KEY_ID are both required for API key notarization.');
    }
    credentials = { appleApiKey, appleApiKeyId, ...(appleApiIssuer ? { appleApiIssuer } : {}) };
  } else if (keychainProfile) {
    credentials = { keychainProfile, ...(keychain ? { keychain } : {}) };
  } else {
    if (!appleId || !appleIdPassword) {
      throw new Error('[notarize] APPLE_ID and APPLE_APP_PASSWORD are both required for Apple ID notarization.');
    }
    credentials = { appleId, appleIdPassword, teamId };
  }

  await notarize({
    tool: 'notarytool',
    appPath,
    ...credentials,
  });

  console.log('[notarize] Done.');
};
