# Can F-Droid put this APK's signature on the one it builds? With fdroidserver's own comparison:
#   python tools/fdroid-match.py <signed.apk> <unsigned.apk>      (fdroidserver installed, apksigner on PATH)
# The release workflow runs it before a release is published: a difference found later costs F-Droid's build
# (hours) and another release.

import shutil
import sys
import tempfile

from fdroidserver import common

signed, unsigned = sys.argv[1:]
common.config = {"apksigner": shutil.which("apksigner"), "sdk_path": "", "keystore": "unused"}
if not common.config["apksigner"]:
    sys.exit("apksigner is not on PATH")
with tempfile.TemporaryDirectory() as tmp:
    # verify_apks works on a copy
    copy = shutil.copy(unsigned, f"{tmp}/unsigned.apk")
    difference = common.verify_apks(signed, copy, tmp)
if difference is not None:
    sys.exit(f"F-Droid couldn't use this APK's signature:\n{difference}")
print("matches: F-Droid can use this APK's signature")
