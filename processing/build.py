"""Export the content workspace after its complete integrity check passes."""
import argparse
import subprocess
from pathlib import Path

root = Path(__file__).resolve().parent
parser = argparse.ArgumentParser()
parser.add_argument("--workspace", default=str(root / "content/relay-demo"))
parser.add_argument("--chunk", default="c0002")
args = parser.parse_args()
(root / "data").mkdir(exist_ok=True)
subprocess.run([
    "node", str(root / "bin/relay.mjs"), "export",
    "--workspace", args.workspace, "--chunk", args.chunk,
    "--out", str(root / "data/article.json"),
    "--browser", str(root / "article-data.js"),
], cwd=root, check=True)
