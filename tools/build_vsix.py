#!/usr/bin/env python3
"""No-dependency VSIX builder using the same XML / folder layout as the prior v1.1.0 package."""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
import json
import html
import sys
root=Path(__file__).resolve().parents[1]
manifest=json.loads((root/'package.json').read_text(encoding='utf8'))
version=manifest['version']
out=Path(sys.argv[1]) if len(sys.argv)>1 else root.parent/f"zh-linux-api-hover-{version}.vsix"
content='''<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="js" ContentType="application/javascript" />
  <Default Extension="json" ContentType="application/json" />
  <Default Extension="md" ContentType="text/markdown" />
  <Default Extension="vsixmanifest" ContentType="text/xml" />
  <Override PartName="/extension/LICENSE" ContentType="text/plain" />
</Types>'''
xml=f'''<?xml version="1.0" encoding="UTF-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
 <Metadata>
  <Identity Id="{html.escape(manifest['name'])}" Version="{html.escape(version)}" Publisher="{html.escape(manifest['publisher'])}" Language="zh-CN" />
  <DisplayName>{html.escape(manifest['displayName'])}</DisplayName>
  <Description xml:space="preserve">{html.escape(manifest['description'])}</Description>
  <Tags>C,Linux,Chinese,Hover,AI,IPC</Tags><Categories>Programming Languages</Categories><GalleryFlags>Public</GalleryFlags>
  <Properties><Property Id="Microsoft.VisualStudio.Code.Engine" Value="{html.escape(manifest['engines']['vscode'])}" /></Properties>
 </Metadata>
 <Installation><InstallationTarget Id="Microsoft.VisualStudio.Code" /></Installation><Dependencies />
 <Assets>
  <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
  <Asset Type="Microsoft.VisualStudio.Code.Details" Path="extension/README.md" Addressable="true" />
  <Asset Type="Microsoft.VisualStudio.Code.License" Path="extension/LICENSE" Addressable="true" />
 </Assets>
</PackageManifest>'''
files=['extension.js','builtin-docs.js','symbol-docs.js','additional-docs.json','categories.json','package.json','README.md','LICENSE','lib/storage.js','lib/symbols.js','lib/symbol-ai.js','lib/ai.js','lib/brief.js','lib/transport.js','lib/revision.js','lib/rich-render.js','CHANGELOG.md']
with ZipFile(out,'w',ZIP_DEFLATED) as z:
    z.writestr('[Content_Types].xml',content)
    z.writestr('extension.vsixmanifest',xml)
    for name in files:
        z.write(root/name,arcname='extension/'+name)
print(f'VSIX packaged: {out} ({out.stat().st_size} bytes)')
