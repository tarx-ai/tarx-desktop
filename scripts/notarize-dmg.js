#!/usr/bin/env node
'use strict';

/**
 * Notarize and staple built DMG artifacts after electron-builder finishes.
 * The afterSign hook notarizes TARX.app; this closes the direct-download DMG gate.
 */

const { existsSync } = require('node:fs');
const { resolve } = require('node:path');
const { notarize } = require('@electron/notarize');

function credentialsFromEnv() {
  const appleApiKey = process.env.APPLE_API_KEY;
  const appleApiKeyId = process.env.APPLE_API_KEY_ID;
  const appleApiIssuer = process.env.APPLE_API_ISSUER;
  const appleId = process.env.APPLE_ID;
  const appleIdPassword = process.env.APPLE_APP_PASSWORD || process.env.APPLE_APP_SPECIFIC_PASSWORD;
  const teamId = process.env.APPLE_TEAM_ID || 'JH4243GARF';
  const keychain = process.env.APPLE_KEYCHAIN;
  const keychainProfile = process.env.APPLE_KEYCHAIN_PROFILE || (!appleApiKey && !appleApiKeyId && !appleId && !appleIdPassword ? 'tarx' : '');

  const modes = [
    appleApiKey || appleApiKeyId ? 'api-key' : '',
    keychainProfile ? 'keychain-profile' : '',
    appleId || appleIdPassword ? 'apple-id-password' : '',
  ].filter(Boolean);

  if (modes.length !== 1) {
    throw new Error(`Expected exactly one notarization credential mode, found ${modes.length || 0}.`);
  }

  if (appleApiKey || appleApiKeyId) {
    if (!appleApiKey || !appleApiKeyId) throw new Error('APPLE_API_KEY and APPLE_API_KEY_ID are both required.');
    return { appleApiKey, appleApiKeyId, ...(appleApiIssuer ? { appleApiIssuer } : {}) };
  }

  if (keychainProfile) {
    return { keychainProfile, ...(keychain ? { keychain } : {}) };
  }

  if (!appleId || !appleIdPassword) throw new Error('APPLE_ID and APPLE_APP_PASSWORD are both required.');
  return { appleId, appleIdPassword, teamId };
}

async function main() {
  const dmgs = process.argv.slice(2);
  if (!dmgs.length) throw new Error('Usage: node scripts/notarize-dmg.js dist/TARX-*.dmg');

  if (process.env.APPLE_SKIP_NOTARIZE === '1') {
    console.warn('[notarize-dmg] APPLE_SKIP_NOTARIZE=1 - skipping DMG notarization');
    return;
  }

  const credentials = credentialsFromEnv();
  for (const input of dmgs) {
    const dmg = resolve(input);
    if (!existsSync(dmg)) throw new Error(`Missing DMG: ${dmg}`);
    console.log(`[notarize-dmg] Submitting ${dmg} to notarytool...`);
    await notarize({
      tool: 'notarytool',
      appPath: dmg,
      ...credentials,
    });
    console.log(`[notarize-dmg] Done: ${dmg}`);
  }
}

main().catch((error) => {
  console.error(`[notarize-dmg] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
