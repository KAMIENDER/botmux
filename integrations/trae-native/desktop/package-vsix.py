#!/usr/bin/env python3
"""Package the original setup extension without a compiler or dependencies."""
from pathlib import Path
import json
import sys
import zipfile
import xml.sax.saxutils

root = Path(__file__).resolve().parent
metadata = json.loads((root / "package.json").read_text())
output = Path(sys.argv[1]).expanduser() if len(sys.argv) > 1 else root / "setup.vsix"
escape = xml.sax.saxutils.escape
manifest = '''<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
<Metadata><Identity Language="en-US" Id="{id}" Version="{version}" Publisher="{publisher}"/>
<DisplayName>{title}</DisplayName><Description xml:space="preserve">{description}</Description>
<Tags>TRAE,botmux</Tags><Categories>Other</Categories><GalleryFlags>Public</GalleryFlags>
<Properties><Property Id="Microsoft.VisualStudio.Code.Engine" Value="^1.95.0"/>
<Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace"/></Properties></Metadata>
<Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation>
<Dependencies/><Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/></Assets>
</PackageManifest>'''.format(id=escape(metadata["name"]), version=metadata["version"],
publisher=escape(metadata["publisher"]), title=escape(metadata["displayName"]), description=escape(metadata["description"]))
with zipfile.ZipFile(str(output), "w", zipfile.ZIP_DEFLATED) as archive:
    archive.writestr("extension.vsixmanifest", manifest)
    archive.writestr("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="json" ContentType="application/json"/><Default Extension="cjs" ContentType="application/javascript"/><Default Extension="vsixmanifest" ContentType="text/xml"/></Types>')
    for name in ("package.json", "extension.cjs"):
        archive.write(str(root / name), "extension/" + name)
print(output)
