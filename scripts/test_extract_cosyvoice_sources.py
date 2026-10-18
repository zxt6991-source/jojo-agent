"""Local source archive integrity/path checks; no third-party dependencies."""
import hashlib
from io import BytesIO
import json
from pathlib import Path
import tarfile
from tempfile import TemporaryDirectory
import unittest

from extract_cosyvoice_sources import extract


class SourceExtractionTests(unittest.TestCase):
    def fixture(self, root, *, link=False, duplicate=False, tamper=False):
        archive = root / "CosyVoice-source.tar.gz"
        content = b"# controlled source\n"
        with tarfile.open(archive, "w:gz") as output:
            for _ in range(2 if duplicate else 1):
                entry = tarfile.TarInfo("revision/cosyvoice/test.py")
                entry.size = len(content)
                if link:
                    entry.type, entry.linkname = tarfile.SYMTYPE, "../../outside"
                    output.addfile(entry)
                else:
                    output.addfile(entry, BytesIO(content))
            extra = tarfile.TarInfo("revision/../../outside")
            extra.size = 3
            output.addfile(extra, BytesIO(b"bad"))
        manifest = root / "manifest.json"
        manifest.write_text(json.dumps({"sources": [{"name": "CosyVoice", "target": "source", "archiveSha256": hashlib.sha256(archive.read_bytes()).hexdigest(),
            "files": [{"path": "cosyvoice/test.py", "bytes": len(content), "sha256": hashlib.sha256(b"wrong" if tamper else content).hexdigest()}]}]}))
        return manifest

    def test_only_pinned_regular_files_are_extracted(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            extract(self.fixture(root), root, root / "output")
            self.assertEqual((root / "output/cosyvoice/test.py").read_bytes(), b"# controlled source\n")
            self.assertFalse((root / "outside").exists())
            self.assertEqual(len(list((root / "output").rglob("*.py"))), 1)

    def test_rejects_links_duplicates_and_source_digest_drift(self):
        for option in ("link", "duplicate", "tamper"):
            with TemporaryDirectory() as temporary:
                root = Path(temporary)
                with self.assertRaises(ValueError):
                    extract(self.fixture(root, **{option: True}), root, root / "output")

    def test_rejects_archive_replacement_before_any_source_is_written(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            manifest = self.fixture(root)
            (root / "CosyVoice-source.tar.gz").write_bytes(b"corrupt archive")
            with self.assertRaises(ValueError):
                extract(manifest, root, root / "output")
            self.assertFalse((root / "output").exists())


if __name__ == "__main__":
    unittest.main()
