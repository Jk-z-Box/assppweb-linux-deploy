"""Build a reproducible source bundle and update the installer's integrity pin."""
import gzip
import hashlib
import io
from pathlib import Path
import re
import tarfile

root = Path(__file__).resolve().parents[1]
buffer = io.BytesIO()
with tarfile.open(fileobj=buffer, mode='w', format=tarfile.USTAR_FORMAT) as archive:
    for file in sorted((root / 'sync').rglob('*')):
        if not file.is_file() or '__pycache__' in file.parts:
            continue
        info = tarfile.TarInfo(file.relative_to(root / 'sync').as_posix())
        content = file.read_bytes()
        info.size = len(content)
        info.mode = 0o644
        info.mtime = 0
        archive.addfile(info, io.BytesIO(content))
destination = root / 'releases' / 'account-sync-1.1.0.tar.gz'
destination.parent.mkdir(exist_ok=True)
destination.write_bytes(gzip.compress(buffer.getvalue(), mtime=0))
checksum = hashlib.sha256(destination.read_bytes()).hexdigest()
installer = root / 'install.sh'
installer.write_text(re.sub(r'^SYNC_BUNDLE_SHA256=.*$', 'SYNC_BUNDLE_SHA256=' + checksum,
                            installer.read_text(), flags=re.MULTILINE))
print(checksum)
