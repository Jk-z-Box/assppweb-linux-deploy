"""Build deterministic release bundles and the checksum-pinned manager manifest."""
import gzip
import hashlib
import io
from pathlib import Path
import re
import tarfile

root = Path(__file__).resolve().parents[1]
installer = root / 'install.sh'
source = installer.read_text()
version = re.search(r'^VERSION=(\S+)$', source, re.MULTILINE)[1]
(root / 'releases').mkdir(exist_ok=True)
for directory, prefix, variable in [('sync', 'account-sync', 'SYNC_BUNDLE_SHA256'),
                                    ('gateway', 'gateway', 'GATEWAY_BUNDLE_SHA256')]:
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode='w', format=tarfile.USTAR_FORMAT) as archive:
        for file in sorted((root / directory).rglob('*')):
            if not file.is_file() or {'__pycache__', 'node_modules'} & set(file.parts):
                continue
            info = tarfile.TarInfo(file.relative_to(root / directory).as_posix())
            content = file.read_bytes()
            info.size, info.mode, info.mtime = len(content), 0o644, 0
            archive.addfile(info, io.BytesIO(content))
    destination = root / 'releases' / f'{prefix}-{version}.tar.gz'
    destination.write_bytes(gzip.compress(buffer.getvalue(), mtime=0))
    checksum = hashlib.sha256(destination.read_bytes()).hexdigest()
    source = re.sub(r'^' + variable + r'=.*$', variable + '=' + checksum, source, flags=re.MULTILINE)
    print(destination.name, checksum)
installer.write_text(source)
(root / 'releases' / f'manager-{version}.sh').write_text(source)
checksum = hashlib.sha256(source.encode()).hexdigest()
(root / 'releases' / 'latest.txt').write_text(f'{version} {checksum}\n')
print('manager', checksum)
