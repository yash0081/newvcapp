#!/usr/bin/env python3
import json
from pathlib import Path

from reportlab.lib.pagesizes import LETTER
from reportlab.pdfgen import canvas


ROOT = Path(__file__).resolve().parents[1]
SRC_DIR = ROOT / "ingestion-input" / "companies"
OUT_DIR = ROOT / "ingestion-input" / "company-pdfs"


def write_pdf(output_path: Path, title: str, body: str) -> None:
  output_path.parent.mkdir(parents=True, exist_ok=True)
  c = canvas.Canvas(str(output_path), pagesize=LETTER)
  width, height = LETTER
  margin_x = 48
  top = height - 48
  line_h = 14
  max_chars = 100

  lines = [title, ""]
  for raw in body.splitlines():
    text = raw if raw else " "
    while len(text) > max_chars:
      lines.append(text[:max_chars])
      text = text[max_chars:]
    lines.append(text)

  y = top
  for i, line in enumerate(lines):
    if y < 48:
      c.showPage()
      y = top
    if i == 0:
      c.setFont("Helvetica-Bold", 12)
    else:
      c.setFont("Helvetica", 10)
    c.drawString(margin_x, y, line)
    y -= line_h

  c.save()


def main() -> None:
  if not SRC_DIR.exists():
    raise SystemExit(f"Missing source dir: {SRC_DIR}")

  json_files = sorted(SRC_DIR.glob("*.json"))
  if not json_files:
    raise SystemExit("No JSON files found.")

  created = 0
  for src in json_files:
    raw = src.read_text(encoding="utf-8")
    parsed = json.loads(raw)
    pretty = json.dumps(parsed, indent=2, ensure_ascii=False)
    out = OUT_DIR / f"{src.stem}.pdf"
    write_pdf(out, src.name, pretty)
    created += 1

  print(f"Created {created} PDFs in {OUT_DIR}")


if __name__ == "__main__":
  main()

