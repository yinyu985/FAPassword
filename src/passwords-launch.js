// Browser-only fallback. Direct app launching and automatic fallback are handled
// by the native helper: external browser protocols cannot report launch failure.
export const PASSWORDS_MODERN_SETTINGS_URL = 'x-apple.systempreferences:com.apple.Passwords';
export const PASSWORDS_SETTINGS_URL = 'x-apple.systempreferences:com.apple.Passwords-Settings.extension';
export const PASSWORDS_HELP_URL = 'https://support.apple.com/105115';
export function passwordsUrl(platform, version) {
  if (platform !== 'macOS' || !/^\d+(?:\.\d+)*$/.test(version || '')) return PASSWORDS_HELP_URL;
  const major = Number(version.split('.')[0]);
  if (major >= 15) return PASSWORDS_MODERN_SETTINGS_URL;
  if (major >= 13) return PASSWORDS_SETTINGS_URL;
  return PASSWORDS_HELP_URL;
}
export async function preparePasswordsLaunch(send, navigatorObject = navigator) {
  const [url, helper] = await Promise.all([
    resolvePasswordsUrl(navigatorObject),
    send({ type: 'getPasswordsLauncher' }).catch(() => null),
  ]);
  return { url, native: helper?.ok === true && helper?.canOpenPasswords === true };
}
export async function resolvePasswordsUrl(navigatorObject = navigator) {
  try {
    const info = await navigatorObject.userAgentData?.getHighEntropyValues(['platformVersion']);
    return passwordsUrl(info?.platform, info?.platformVersion);
  } catch { return PASSWORDS_HELP_URL; }
}
