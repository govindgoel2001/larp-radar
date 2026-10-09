"""Build dist/larp-radar-v<version>.zip with only the files Chrome needs."""
import json
import pathlib
import zipfile

root = pathlib.Path(__file__).resolve().parent.parent
version = json.loads((root / 'manifest.json').read_text(encoding='utf-8'))['version']
files = ['manifest.json', 'background.js', 'content.js', 'options.html', 'options.js', 'LICENSE', 'README.md']
files += [str(p.relative_to(root)) for p in sorted((root / 'lib').glob('*.js'))]
files += [str(p.relative_to(root)) for p in sorted((root / 'icons').glob('*.png'))]

out = root / 'dist' / f'larp-radar-v{version}.zip'
out.parent.mkdir(exist_ok=True)
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    for f in files:
        # One top-level folder, so unzipping gives people a single "larp-radar" folder to load.
        z.write(root / f, f'larp-radar/{pathlib.PurePath(f).as_posix()}')
print(f'{out.relative_to(root)}  {out.stat().st_size // 1024} KB, {len(files)} files')
