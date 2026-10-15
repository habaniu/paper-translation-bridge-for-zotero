"""Read-only glyph geometry. PDF.js remains the owner of item IDs.

pdfplumber supplies measured character boxes, never equal-width interpolation.
Unsupported rotation/nonzero MediaBox is explicit; no guessed transforms.
"""
import json
import sys
import pdfplumber

with pdfplumber.open(sys.argv[1]) as pdf:
    result = []
    for page in pdf.pages:
        if page.rotation or page.mediabox[:2] != (0, 0):
            result.append({"unsupported": "rotated page or nonzero MediaBox origin", "chars": []})
            continue
        result.append({"chars": [
            {"text": c["text"], "rect": [c["x0"], c["y0"], c["x1"], c["y1"]],
             "baseline": c["matrix"][5], "upright": c.get("upright", True)}
            for c in page.chars
        ]})
    json.dump(result, sys.stdout, ensure_ascii=False)
