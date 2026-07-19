"""Manual detector check: fetch live frames (or read files), annotate, save PNGs.

Usage: python scraper/test_detect.py --out /tmp/annotated [camera-id-or-image-path ...]
With no positional args, tests the 4 nearest polled cameras.
"""
import argparse
import io
import json
import sys
import urllib.request
from pathlib import Path

from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).parent))
from detect import Detector, VEHICLE_CLASSES

SNAPSHOT = "https://webcams.nyctmc.org/api/cameras/{id}/image"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=".")
    ap.add_argument("--model", default="models/yolov8n.onnx")
    ap.add_argument("targets", nargs="*")
    args = ap.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    cams = {c["id"]: c["name"]
            for c in json.loads(Path("site/data/cameras.json").read_text())["cameras"]}
    targets = args.targets or list(cams)[:4]
    det = Detector(args.model)

    for t in targets:
        if Path(t).exists():
            img, label = Image.open(t), Path(t).stem
        else:
            req = urllib.request.Request(SNAPSHOT.format(id=t),
                                         headers={"User-Agent": "parkscout-test"})
            img = Image.open(io.BytesIO(urllib.request.urlopen(req, timeout=15).read()))
            label = cams.get(t, t[:8])
        boxes = det.detect(img)
        big = img.convert("RGB").resize((img.width * 3, img.height * 3), Image.LANCZOS)
        draw = ImageDraw.Draw(big)
        for x1, y1, x2, y2, conf, cls in boxes:
            draw.rectangle([x1 * 3, y1 * 3, x2 * 3, y2 * 3], outline=(80, 220, 120), width=2)
            draw.text((x1 * 3 + 2, y1 * 3 + 2), f"{VEHICLE_CLASSES[cls]} {conf:.2f}",
                      fill=(80, 220, 120))
        safe = label.replace(" ", "_").replace("@", "at").replace("/", "-")
        big.save(out / f"{safe}.png")
        print(f"{label}: {len(boxes)} vehicles "
              f"({', '.join(f'{VEHICLE_CLASSES[c]} {cf:.2f}' for *_, cf, c in boxes) or 'none'})")


if __name__ == "__main__":
    main()
