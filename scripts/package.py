"""Package only runtime files and verify the release tag matches the manifest."""
import json
import os
from pathlib import Path
import re
import subprocess
import zipfile

root = Path(__file__).resolve().parent.parent
manifest = json.loads((root / "manifest.json").read_text())
version = manifest["version"]
tag = os.environ.get("RELEASE_TAG", "v" + version)
if tag != "v" + version:
    raise SystemExit(f"Tag {tag} does not match manifest version {version}")
files = [
    "manifest.json", "account.js", "background.js", "backup.mjs", "content.js",
    "history.mjs", "parser.js", "popup.html", "popup.js", "theme.js",
]
out = root / "dist"
out.mkdir(exist_ok=True)
archive = out / f"rezka-progress-{version}.zip"
subprocess.run(["git", "archive", "--format=zip", f"--output={archive}", "HEAD", *files], cwd=root, check=True)
with zipfile.ZipFile(archive) as zipped:
    if zipped.testzip() is not None:
        raise SystemExit("ZIP integrity check failed")
    packaged = json.loads(zipped.read("manifest.json"))
    if packaged != manifest:
        raise SystemExit("Commit manifest changes before packaging")
    references = [manifest["background"]["service_worker"], manifest["action"]["default_popup"]]
    references += [name for script in manifest["content_scripts"] for name in script["js"]]
    for name in files:
        if name.endswith((".js", ".mjs")):
            references += re.findall(r"from ['\"]\./([^'\"]+)['\"]", zipped.read(name).decode())
    references += re.findall(r'<script[^>]+src="([^"]+)"', zipped.read("popup.html").decode())
    missing = set(references) - set(zipped.namelist())
    if missing:
        raise SystemExit(f"Missing runtime files: {sorted(missing)}")
print(archive)
