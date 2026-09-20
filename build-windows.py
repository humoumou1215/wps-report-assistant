#!/usr/bin/env python3
"""Cross-build the Windows validation ZIP from clean, temporary payload staging."""
from pathlib import Path
import hashlib, json, os, re, shutil, struct, subprocess, tempfile, zipfile
root = Path(__file__).resolve().parent
version = re.search(r'const version = "([^"]+)"', (root/'core-go/server.go').read_text()).group(1)
assert f'const version = "{version}"' in (root/'installer/main.go').read_text()
for module in ['core-go','installer']:
    subprocess.run(['go','test','./...'],cwd=root/module,check=True)
    subprocess.run(['go','vet','./...'],cwd=root/module,check=True)
subprocess.run(['node','--test',*map(str,sorted((root/'tests').glob('*.test.cjs')))],cwd=root,check=True)
out = root/'dist'/f'windows-x64-{version}'
out.mkdir(parents=True,exist_ok=True)
setup = f'DataReportAssistant-Setup-{version}.exe'
docs = ['README.md','VALIDATION_GUIDE.md','DEBUG_GUIDE.md','CHANGE_HISTORY.md','HOST_CAPABILITIES.md','WINDOWS_VALIDATION.md','JAVASCRIPT_VALIDATION.md','THIRD_PARTY_NOTICES.md']
with tempfile.TemporaryDirectory(prefix='ra-windows-') as temp:
    stage=Path(temp)/'installer';stage.mkdir();payload=stage/'payload/app';payload.mkdir(parents=True)
    for file in (root/'installer').glob('*.go'):shutil.copy2(file,stage/file.name)
    shutil.copy2(root/'installer/go.mod',stage/'go.mod')
    for folder in ['addins','samples']:shutil.copytree(root/folder,payload/folder)
    for doc in docs:shutil.copy2(root/doc,payload/doc)
    (payload/'VERSION.txt').write_text(version+'\n')
    env=dict(os.environ,GOOS='windows',GOARCH='amd64',CGO_ENABLED='0')
    subprocess.run(['go','build','-trimpath','-ldflags','-s -w -H=windowsgui','-o',str(payload/'DataReportAssistantCore.exe'),'.'],cwd=root/'core-go',env=env,check=True)
    manifest={'version':version,'target':'windows/amd64','files':{p.relative_to(payload).as_posix():hashlib.sha256(p.read_bytes()).hexdigest() for p in payload.rglob('*') if p.is_file()}}
    (payload/'BUILD_MANIFEST.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf-8')
    subprocess.run(['go','build','-trimpath','-ldflags','-s -w -H=windowsgui','-o',str(out/setup),'.'],cwd=stage,env=env,check=True)
    for binary in [payload/'DataReportAssistantCore.exe',out/setup]:
        data=binary.read_bytes();offset=struct.unpack_from('<I',data,0x3c)[0]
        assert data[:2]==b'MZ' and data[offset:offset+4]==b'PE\0\0'
        assert struct.unpack_from('<H',data,offset+4)[0]==0x8664
        assert struct.unpack_from('<H',data,offset+24+68)[0]==2
    shutil.copy2(payload/'BUILD_MANIFEST.json',out/'BUILD_MANIFEST.json')
for doc in docs:shutil.copy2(root/doc,out/doc)
shutil.copytree(root/'samples',out/'samples',dirs_exist_ok=True)
(out/'SHA256SUMS.txt').write_text(hashlib.sha256((out/setup).read_bytes()).hexdigest()+'  '+setup+'\n')
archive=root/'dist'/f'DataReportAssistant-Windows-x64-{version}.zip'
with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED) as z:
    for p in sorted(out.rglob('*')):
        if p.is_file():z.write(p,p.relative_to(out).as_posix())
with zipfile.ZipFile(archive) as z:assert z.testzip() is None
print(archive)
print(f'{archive.stat().st_size/1024**2:.2f} MiB')
print('SHA256',hashlib.sha256(archive.read_bytes()).hexdigest())
