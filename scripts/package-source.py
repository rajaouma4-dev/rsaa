import os
import zipfile
import hashlib
from pathlib import Path

def create_clean_zip(root_dir: Path, zip_path: Path):
    exclude_dirs = {
        'node_modules', 'target', 'build', '.git', '.gradle', 'deliverables',
        '.gemini', '.idea', '.vscode', '__pycache__', 'dist'
    }
    exclude_extensions = {'.keystore', '.jks', '.apk', '.zip', '.exe'}
    exclude_files = {'.env'}

    print(f"Creating clean source zip at: {zip_path}")
    with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as zipf:
        for root, dirs, files in os.walk(root_dir):
            dirs[:] = [d for d in dirs if d not in exclude_dirs]
            for file in files:
                ext = Path(file).suffix.lower()
                if file in exclude_files or ext in exclude_extensions:
                    continue
                file_path = Path(root) / file
                rel_path = file_path.relative_to(root_dir)
                zipf.write(file_path, arcname=str(rel_path))
    print(f"Zip created. Size: {zip_path.stat().st_size} bytes")

def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        while chunk := f.read(65536):
            h.update(chunk)
    return h.hexdigest()

if __name__ == '__main__':
    workspace = Path(__file__).resolve().parent.parent
    deliv_dir = workspace / 'deliverables'
    deliv_dir.mkdir(exist_ok=True)

    zip_target = deliv_dir / 'nexachat-final-source.zip'
    create_clean_zip(workspace, zip_target)
