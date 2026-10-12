"""Release archive verification tests; fixtures contain no production data."""

import copy
import gzip
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / 'scripts' / 'verify-release.py'
SPEC = importlib.util.spec_from_file_location('verify_release', SCRIPT)
VERIFIER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(VERIFIER)


class ReleaseVerificationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.archive = self.directory / 'candidate.tgz'
        self.manifest_path = self.directory / 'approved.json'
        self.files = {
            'package/package.json': b'{"name":"@oveyon/test-release","version":"0.1.0"}',
            'package/README.md': b'Reviewed release contents.\n',
        }
        self.write_archive()
        self.manifest = {
            'schemaVersion': 1,
            'packageName': '@oveyon/test-release',
            'version': '0.1.0',
            'approvedTarballSha256': hashlib.sha256(self.archive.read_bytes()).hexdigest(),
            'files': [
                {'path': name, 'size': len(content), 'mode': '0644',
                 'sha256': hashlib.sha256(content).hexdigest()}
                for name, content in sorted(self.files.items())
            ],
        }
        self.write_manifest()

    def write_archive(self, entries=None, gzip_mtime=0, trailer=b''):
        entries = entries if entries is not None else [
            (name, content, {}) for name, content in self.files.items()
        ]
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode='w:', format=tarfile.PAX_FORMAT) as archive:
            for name, content, options in entries:
                entry = tarfile.TarInfo(name)
                entry.size = len(content)
                entry.mode = 0o644
                for key, value in options.items():
                    setattr(entry, key, value)
                archive.addfile(entry, io.BytesIO(content))
        self.archive.write_bytes(gzip.compress(buffer.getvalue() + trailer, mtime=gzip_mtime))

    def write_manifest(self):
        self.manifest_path.write_text(json.dumps(self.manifest), encoding='utf-8')

    def verify(self, require_hash=False):
        return VERIFIER.verify_release(self.archive, self.manifest_path, require_hash)

    def assert_rejected(self, text):
        with self.assertRaisesRegex(VERIFIER.VerificationError, text):
            self.verify()

    def test_approved_archive_matches_original_hash_and_all_files(self):
        result = self.verify(require_hash=True)
        self.assertEqual(result['files'], 2)
        self.assertEqual(result['version'], '0.1.0')
        self.assertEqual(result['candidateTarballSha256'], result['approvedTarballSha256'])

    def test_gzip_metadata_may_differ_but_strict_approval_hash_rejects_it(self):
        self.write_archive(gzip_mtime=1)
        result = self.verify()
        self.assertNotEqual(result['candidateTarballSha256'], result['approvedTarballSha256'])
        with self.assertRaisesRegex(VERIFIER.VerificationError, 'approved archive hash'):
            self.verify(require_hash=True)

    def test_file_order_may_differ(self):
        self.write_archive(list(reversed([(name, data, {}) for name, data in self.files.items()])))
        self.assertEqual(self.verify()['files'], 2)

    def test_content_change_of_same_size_is_rejected(self):
        self.files['package/README.md'] = b'X' * len(self.files['package/README.md'])
        self.write_archive()
        self.assert_rejected('File content differs')

    def test_size_change_is_rejected(self):
        self.files['package/README.md'] += b'additional content'
        self.write_archive()
        self.assert_rejected('File size or permissions differ')

    def test_extra_file_is_rejected(self):
        self.files['package/unreviewed.js'] = b'new content'
        self.write_archive()
        self.assert_rejected('outside the approved manifest')

    def test_missing_file_is_rejected(self):
        del self.files['package/README.md']
        self.write_archive()
        self.assert_rejected('missing an approved file')

    def test_duplicate_file_is_rejected(self):
        entries = [(name, data, {}) for name, data in self.files.items()]
        self.write_archive(entries + [entries[-1]])
        self.assert_rejected('duplicate file')

    def test_unsafe_archive_paths_are_rejected(self):
        for name in ('/package/README.md', 'package/../README.md',
                     'package/a/../../README.md', 'package/a\\README.md',
                     'package//README.md', 'package/./README.md'):
            with self.subTest(name=name):
                self.write_archive([(name, b'data', {})])
                self.assert_rejected('path|inside package')

    def test_links_directories_and_special_entries_are_rejected(self):
        for kind in (tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.DIRTYPE,
                     tarfile.FIFOTYPE, tarfile.CHRTYPE, tarfile.BLKTYPE):
            with self.subTest(kind=kind):
                self.write_archive([('package/package.json', b'',
                                     {'type': kind, 'linkname': '/tmp/untrusted'})])
                self.assert_rejected('Only regular files')

    def test_permission_changes_are_rejected(self):
        self.write_archive([(name, data, {'mode': 0o755}) for name, data in self.files.items()])
        self.assert_rejected('File size or permissions differ')

    def test_extended_metadata_is_rejected(self):
        self.write_archive([(name, data, {'pax_headers': {'comment': 'unreviewed'}})
                            for name, data in self.files.items()])
        self.assert_rejected('Extended archive metadata')

    def test_content_after_tar_terminator_is_rejected(self):
        self.write_archive(trailer=b'unreviewed appended data')
        self.assert_rejected('unverified trailing content')

    def test_missing_tar_terminator_is_rejected(self):
        uncompressed = gzip.decompress(self.archive.read_bytes())
        end = sum(512 + ((len(content) + 511) // 512) * 512 for content in self.files.values())
        self.archive.write_bytes(gzip.compress(uncompressed[:end]))
        self.assert_rejected('missing terminator')

    def test_manifest_duplicate_and_unsafe_paths_are_rejected(self):
        original = copy.deepcopy(self.manifest)
        self.manifest['files'].append(copy.deepcopy(self.manifest['files'][0]))
        self.write_manifest()
        self.assert_rejected('Duplicate manifest')
        self.manifest = original
        self.manifest['files'][0]['path'] = 'package/../README.md'
        self.write_manifest()
        self.assert_rejected('Unsafe archive path')

    def test_manifest_must_have_supported_schema_and_package_json(self):
        original = copy.deepcopy(self.manifest)
        self.manifest['schemaVersion'] = 2
        self.write_manifest()
        self.assert_rejected('Unsupported manifest schema')
        self.manifest = original
        self.manifest['files'] = [item for item in self.manifest['files']
                                  if item['path'] != 'package/package.json']
        self.write_manifest()
        self.assert_rejected('must include package.json')

    def test_manifest_identity_must_match_the_hashed_package_json(self):
        self.manifest['version'] = '9.9.9'
        self.write_manifest()
        self.assert_rejected('package identity differs')

    def test_archive_and_manifest_symlinks_are_rejected(self):
        archive_link = self.directory / 'linked.tgz'
        archive_link.symlink_to(self.archive)
        with self.assertRaisesRegex(VERIFIER.VerificationError, 'not a symbolic link'):
            VERIFIER.verify_release(archive_link, self.manifest_path)
        manifest_link = self.directory / 'linked.json'
        manifest_link.symlink_to(self.manifest_path)
        with self.assertRaisesRegex(VERIFIER.VerificationError, 'Invalid manifest file'):
            VERIFIER.verify_release(self.archive, manifest_link)

    def test_compressed_unpacked_and_manifest_limits_are_enforced(self):
        with patch.object(VERIFIER, 'MAX_COMPRESSED_BYTES', 1):
            self.assert_rejected('Compressed tarball exceeds')
        with patch.object(VERIFIER, 'MAX_UNPACKED_BYTES', 1024):
            self.assert_rejected('Unpacked tarball exceeds')
        with patch.object(VERIFIER, 'MAX_MANIFEST_BYTES', 1):
            self.assert_rejected('Invalid manifest file')

    def test_cli_returns_success_with_checked_digest(self):
        result = subprocess.run([sys.executable, '-B', str(SCRIPT), str(self.archive),
                                 str(self.manifest_path), '--require-approved-sha256'],
                                capture_output=True, text=True, check=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)['status'], 'PASS')

    def test_cli_rejects_truncated_and_corrupt_gzip_without_traceback(self):
        original = self.archive.read_bytes()
        for content in (original[:-9], b'not a gzip archive',
                        original[:10] + b'\xff' * 30 + original[-8:]):
            with self.subTest(length=len(content)):
                self.archive.write_bytes(content)
                result = subprocess.run([sys.executable, '-B', str(SCRIPT), str(self.archive),
                                         str(self.manifest_path)],
                                        capture_output=True, text=True, check=False)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('Release verification FAILED:', result.stderr)
                self.assertNotIn('Traceback', result.stderr)
                self.assertEqual(result.stdout, '')


if __name__ == '__main__':
    unittest.main()
