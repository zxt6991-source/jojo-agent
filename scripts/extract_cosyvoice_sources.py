"""Extract only manifest-listed regular source files from verified archives."""
import hashlib
import json
from pathlib import Path, PurePosixPath
import sys
import tarfile


def extract(manifest_path, archive_root, destination):
    manifest = json.loads(Path(manifest_path).read_text())
    root = Path(destination)
    for source in manifest["sources"]:
        archive = Path(archive_root) / (source["name"] + "-source.tar.gz")
        if hashlib.sha256(archive.read_bytes()).hexdigest() != source["archiveSha256"]:
            raise ValueError("source_digest_mismatch")
        relative_root = PurePosixPath(source["target"]).relative_to("source")
        if ".." in relative_root.parts or relative_root.is_absolute():
            raise ValueError("source_path_invalid")
        expected = {file["path"]: file for file in source["files"]}
        found = set()
        with tarfile.open(archive) as stream:
            for member in stream:
                relative = PurePosixPath(*PurePosixPath(member.name).parts[1:])
                name = str(relative)
                if name not in expected:
                    continue
                file = expected[name]
                if not member.isfile() or relative.is_absolute() or ".." in relative.parts or member.size != file["bytes"] or member.size > 2 * 1024 * 1024 or name in found:
                    raise ValueError("source_entry_invalid")
                data = stream.extractfile(member).read()
                if hashlib.sha256(data).hexdigest() != file["sha256"]:
                    raise ValueError("source_entry_digest_mismatch")
                target = root / relative_root / relative
                target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                with target.open("xb") as output:
                    output.write(data)
                target.chmod(0o600)
                found.add(name)
        if found != set(expected):
            raise ValueError("source_entries_missing")


if __name__ == "__main__":
    extract(*sys.argv[1:])
