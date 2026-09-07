import ctypes
import importlib.util
import io
import os
import plistlib
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('policy', os.path.join(os.path.dirname(__file__), '../../native/fapassword-policy.py'))
policy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(policy)

class FakeCF:
    def __init__(self, values):
        self.values = values
        self.read = []
        self.released = []
    def CFStringCreateWithCString(self, _, text, encoding):
        return text.decode()
    def CFPreferencesGetAppBooleanValue(self, key, app, valid):
        self.read.append(app)
        forced, value = self.values.get(app, (False, None))
        ctypes.cast(valid, ctypes.POINTER(ctypes.c_bool))[0] = value is not None
        return bool(value)
    def CFPreferencesAppValueIsForced(self, key, app):
        return self.values.get(app, (False, None))[0]
    def CFRelease(self, value):
        self.released.append(value)

class PolicyTests(unittest.TestCase):
    def test_passwords_capabilities_have_no_side_effects(self):
        with patch.object(policy.subprocess, 'run') as run, patch.object(policy, 'read_policy') as read:
            self.assertEqual(policy.handle('passwordsCapabilities', 'net.imput.helium'),
                             {'ok': True, 'canOpenPasswords': True})
        run.assert_not_called()
        read.assert_not_called()

    def test_passwords_app_launch_does_not_open_settings_or_read_policy(self):
        with patch.object(policy.subprocess, 'run') as run, patch.object(policy, 'read_policy') as read:
            self.assertEqual(policy.handle('openPasswords', 'net.imput.helium'), {'ok': True, 'target': 'app'})
        run.assert_called_once_with(['/usr/bin/open', '-b', 'com.apple.Passwords'], check=True, timeout=10)
        read.assert_not_called()

    def test_passwords_falls_back_on_missing_app_failure_or_timeout(self):
        failures = [FileNotFoundError(), policy.subprocess.CalledProcessError(1, 'open'),
                    policy.subprocess.TimeoutExpired('open', 10)]
        for version, pane in [('14.7.6', 'com.apple.Passwords-Settings.extension'),
                              ('15.7.7', 'com.apple.Passwords'), ('26.0', 'com.apple.Passwords')]:
            for failure in failures:
                with self.subTest(version=version, failure=type(failure).__name__), \
                     patch.object(policy.platform, 'mac_ver', return_value=(version, (), '')), \
                     patch.object(policy.subprocess, 'run', side_effect=[failure, None]) as run:
                    self.assertEqual(policy.open_passwords(), {'ok': True, 'target': 'settings'})
                    self.assertEqual(run.call_count, 2)
                    self.assertEqual(run.call_args_list[0].args[0], ['/usr/bin/open', '-b', 'com.apple.Passwords'])
                    self.assertEqual(run.call_args_list[1].args[0], ['/usr/bin/open', 'x-apple.systempreferences:' + pane])

    def test_both_launch_failures_are_reported(self):
        with patch.object(policy.platform, 'mac_ver', return_value=('15.7.7', (), '')), \
             patch.object(policy.subprocess, 'run', side_effect=policy.subprocess.CalledProcessError(1, 'open')):
            with self.assertRaises(policy.subprocess.CalledProcessError):
                policy.open_passwords()

    def test_forced_true_does_not_mean_hidden(self):
        with patch.object(policy, '_CF', FakeCF({'com.google.Chrome': (True, True)})):
            result = policy.read_policy('com.google.Chrome')
        self.assertTrue(result['managed'])
        self.assertFalse(result['hidden'])
        self.assertTrue(result['value'])

    def test_forced_false_is_hidden(self):
        cf = FakeCF({'com.google.Chrome': (True, False)})
        with patch.object(policy, '_CF', cf):
            self.assertTrue(policy.read_policy('com.google.Chrome')['hidden'])
        self.assertEqual(len(cf.released), 2)

    def test_other_browser_policy_does_not_leak(self):
        cf = FakeCF({'com.google.Chrome': (True, False), 'net.imput.helium': (False, None)})
        with patch.object(policy, '_CF', cf):
            result = policy.read_policy('net.imput.helium')
        self.assertFalse(result['hidden'])
        self.assertFalse(result['managed'])
        self.assertIsNone(result['value'])
        self.assertEqual(cf.read, ['net.imput.helium'])

    def test_unmanaged_false_is_not_a_managed_hide(self):
        with patch.object(policy, '_CF', FakeCF({'com.google.Chrome': (False, False)})):
            result = policy.read_policy('com.google.Chrome')
        self.assertFalse(result['hidden'])
        self.assertEqual(result['controlSource'], 'user')

    def test_every_profile_has_exactly_the_current_browser(self):
        identifiers = set()
        for bundle in policy.BUNDLES:
            profile = policy.profile_data(bundle)
            self.assertEqual(len(profile['PayloadContent']), 1)
            self.assertEqual(profile['PayloadContent'][0]['PayloadType'], bundle)
            self.assertIs(profile['PayloadContent'][0][policy.KEY], False)
            identifiers.add(profile['PayloadIdentifier'])
        self.assertEqual(len(identifiers), len(policy.BUNDLES))
        with self.assertRaises(ValueError):
            policy.profile_data('other.app')

    def test_profile_files_do_not_overwrite_another_browser(self):
        with tempfile.TemporaryDirectory(prefix='fapassword-policy-') as directory, patch.object(policy, 'APPDIR', directory):
            chrome = policy.write_profile('com.google.Chrome')
            helium = policy.write_profile('net.imput.helium')
            self.assertNotEqual(chrome, helium)
            with open(helium, 'rb') as source:
                self.assertEqual(plistlib.load(source)['PayloadContent'][0]['PayloadType'], 'net.imput.helium')

    def test_parent_process_determines_scope(self):
        plist = plistlib.dumps({'CFBundleIdentifier': 'net.imput.helium'})
        with patch.object(policy.subprocess, 'check_output', return_value='/Applications/Helium.app/Contents/MacOS/Helium'), patch('builtins.open', return_value=io.BytesIO(plist)):
            self.assertEqual(policy.current_browser(), 'net.imput.helium')

    def test_unrecognized_parent_fails_closed(self):
        with patch.object(policy.subprocess, 'check_output', side_effect=['/usr/bin/python3','1']):
            with self.assertRaises(RuntimeError):
                policy.current_browser()

    def test_open_failure_is_visible(self):
        with tempfile.TemporaryDirectory(prefix='fapassword-policy-') as directory, patch.object(policy, 'APPDIR', directory), patch.object(policy.subprocess, 'run', side_effect=RuntimeError('open failed')):
            with self.assertRaisesRegex(RuntimeError, 'open failed'):
                policy.handle('set', 'net.imput.helium')

    @unittest.skipUnless(os.uname().sysname == 'Darwin', 'requires real macOS CoreFoundation')
    def test_real_core_foundation_read_only(self):
        # Reads one current application preference. Does not create/install policy or access a vault.
        with patch.object(policy, '_CF', None):
            result = policy.read_policy('net.imput.helium')
        self.assertIn(result['value'], [None, True, False])
        self.assertEqual(result['browser'], 'net.imput.helium')

if __name__ == '__main__':
    unittest.main(verbosity=2)
