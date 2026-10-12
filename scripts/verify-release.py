#!/usr/bin/env python3
"""Compare an npm tarball with a reviewed manifest without extracting files."""

import argparse
import gzip
import hashlib
import io
import json
from pathlib import Path
import re
import sys
import tarfile
import zlib


MAX_COMPRESSED_BYTES = 8 * 1024 * 1024
MAX_UNPACKED_BYTES = 32 * 1024 * 1024
MAX_MANIFEST_BYTES = 128 * 1024


class VerificationError(ValueError):
    pass


def safe_member_path(value):
    if not isinstance(value, str) or len(value) > 240:
        raise VerificationError('Invalid archive path.')
    parts = value.split('/')
    if parts[0] != 'package' or len(parts) < 2:
        raise VerificationError('Archive entries must be inside package/.')
    if any(part in ('', '.', '..') or not re.fullmatch(r'[A-Za-z0-9._-]+', part) for part in parts):
        raise VerificationError('Unsafe archive path.')
    return value


def read_manifest(path):
    path = Path(path)
    if path.is_symlink() or not path.is_file() or path.stat().st_size > MAX_MANIFEST_BYTES:
        raise VerificationError('Invalid manifest file.')
    manifest = json.loads(path.read_text(encoding='utf-8'))
    if not isinstance(manifest, dict) or manifest.get('schemaVersion') != 1:
        raise VerificationError('Unsupported manifest schema.')
    if not isinstance(manifest.get('packageName'), str) or not isinstance(manifest.get('version'), str):
        raise VerificationError('Manifest package identity is missing.')
    if not re.fullmatch(r'[a-f0-9]{64}', str(manifest.get('approvedTarballSha256', ''))):
        raise VerificationError('Manifest approval hash is invalid.')
    files = manifest.get('files')
    if not isinstance(files, list) or not files or len(files) > 256:
        raise VerificationError('Manifest file list is invalid.')
    expected = {}
    for item in files:
        if not isinstance(item, dict):
            raise VerificationError('Invalid manifest entry.')
        name = safe_member_path(item.get('path'))
        if name in expected:
            raise VerificationError('Duplicate manifest entry.')
        if type(item.get('size')) is not int or not 0 <= item['size'] <= MAX_UNPACKED_BYTES:
            raise VerificationError('Invalid manifest file size.')
        if item.get('mode') != '0644' or not re.fullmatch(r'[a-f0-9]{64}', str(item.get('sha256', ''))):
            raise VerificationError('Invalid manifest file hash or mode.')
        expected[name] = item
    if 'package/package.json' not in expected:
        raise VerificationError('Manifest must include package.json.')
    if sum(item['size'] for item in files) > MAX_UNPACKED_BYTES:
        raise VerificationError('Manifest exceeds the size limit.')
    return manifest, expected


def verify_release(tarball_path, manifest_path, require_approved_sha256=False):
    manifest, expected = read_manifest(manifest_path)
    tarball_path = Path(tarball_path)
    if tarball_path.is_symlink() or not tarball_path.is_file():
        raise VerificationError('Tarball must be a regular file, not a symbolic link.')
    if tarball_path.stat().st_size > MAX_COMPRESSED_BYTES:
        raise VerificationError('Compressed tarball exceeds the size limit.')
    compressed = tarball_path.read_bytes()
    candidate_sha256 = hashlib.sha256(compressed).hexdigest()
    if require_approved_sha256 and candidate_sha256 != manifest['approvedTarballSha256']:
        raise VerificationError('Tarball does not match the approved archive hash.')
    with gzip.GzipFile(fileobj=io.BytesIO(compressed), mode='rb') as stream:
        unpacked = stream.read(MAX_UNPACKED_BYTES + 1)
    if len(unpacked) > MAX_UNPACKED_BYTES:
        raise VerificationError('Unpacked tarball exceeds the size limit.')

    seen = set()
    next_offset = 0
    package_json = None
    with tarfile.open(fileobj=io.BytesIO(unpacked), mode='r:', errorlevel=2) as archive:
        for entry in archive:
            name = safe_member_path(entry.name)
            if name not in expected:
                raise VerificationError('Tarball contains a file outside the approved manifest.')
            if name in seen:
                raise VerificationError('Tarball contains a duplicate file.')
            if not entry.isreg() or entry.issym() or entry.islnk():
                raise VerificationError('Only regular files are allowed in the tarball.')
            # The approved npm archive uses plain regular-file headers. Refuse
            # hidden PAX/GNU metadata, sparse layouts, gaps, and special entries.
            if entry.pax_headers or entry.sparse is not None:
                raise VerificationError('Extended archive metadata is not allowed.')
            if entry.offset != next_offset or entry.offset_data != entry.offset + 512:
                raise VerificationError('Unexpected archive header layout.')
            approved = expected[name]
            if entry.size != approved['size'] or entry.mode != int(approved['mode'], 8):
                raise VerificationError(f'File size or permissions differ: {name}')
            with archive.extractfile(entry) as source:
                content = source.read(entry.size + 1)
            if len(content) != entry.size or hashlib.sha256(content).hexdigest() != approved['sha256']:
                raise VerificationError(f'File content differs: {name}')
            if name == 'package/package.json':
                package_json = json.loads(content)
            seen.add(name)
            next_offset = entry.offset_data + ((entry.size + 511) // 512) * 512

    if seen != set(expected):
        raise VerificationError('Tarball is missing an approved file.')
    trailer = unpacked[next_offset:]
    if len(trailer) < 1024 or any(trailer):
        raise VerificationError('Tarball has a missing terminator or unverified trailing content.')
    if not isinstance(package_json, dict) or package_json.get('name') != manifest['packageName'] or package_json.get('version') != manifest['version']:
        raise VerificationError('Tarball package identity differs from the approved manifest.')
    return {
        'packageName': manifest['packageName'],
        'version': manifest['version'],
        'files': len(seen),
        'approvedTarballSha256': manifest['approvedTarballSha256'],
        'candidateTarballSha256': candidate_sha256,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('tarball', type=Path)
    parser.add_argument('manifest', type=Path)
    parser.add_argument('--require-approved-sha256', action='store_true', help='Also require byte-for-byte equality with the original approved gzip archive.')
    args = parser.parse_args()
    try:
        result = verify_release(args.tarball, args.manifest, args.require_approved_sha256)
    except (VerificationError, OSError, EOFError, tarfile.TarError, json.JSONDecodeError, UnicodeError, zlib.error) as error:
        print(f'Release verification FAILED: {error}', file=sys.stderr)
        return 1
    print(json.dumps({'status': 'PASS', **result}, sort_keys=True))
    return 0


if __name__ == '__main__':
    sys.exit(main())
