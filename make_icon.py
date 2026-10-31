"""
make_icon.py — genere assets/icon.ico et assets/icon.png depuis assets/icon.svg

    python make_icon.py                 (depuis le dossier de l'app)
    python make_icon.py chemin/vers.svg

- icon.ico : 16, 24, 32, 48, 64, 128, 256 px, rendues UNE PAR UNE depuis le SVG
  (donc nettes meme en 16 px), pour l'executable et la barre des taches Windows.
- icon.png : 256 px, pour le README / la fiche GitHub.

Aucune dependance en plus : utilise le moteur SVG de Qt (PyQt6 ou PySide6,
selon ce qui est installe) et Pillow, deja presents dans le projet.

L'icone de FENETRE, elle, charge directement assets/icon.svg a l'execution
(voir main.py) : pas besoin de relancer ce script pour la voir changer.
"""

from __future__ import annotations

import io
import sys
from pathlib import Path

try:
    from PyQt6.QtSvg import QSvgRenderer
    from PyQt6.QtGui import QGuiApplication, QImage, QPainter
    from PyQt6.QtCore import QBuffer, QByteArray, QRectF
except ImportError:  # PySide6 (Videoscope, Tracker)
    from PySide6.QtSvg import QSvgRenderer
    from PySide6.QtGui import QGuiApplication, QImage, QPainter
    from PySide6.QtCore import QBuffer, QByteArray, QRectF

from PIL import Image

SIZES = [16, 24, 32, 48, 64, 128, 256]


def _render(svg: QSvgRenderer, size: int) -> Image.Image:
    """SVG -> PIL.Image RGBA, carre `size`, fond transparent, ratio conserve."""
    img = QImage(size, size, QImage.Format.Format_ARGB32)
    img.fill(0)
    p = QPainter(img)
    p.setRenderHint(QPainter.RenderHint.Antialiasing, True)
    p.setRenderHint(QPainter.RenderHint.SmoothPixmapTransform, True)

    vb = svg.viewBoxF()
    if vb.width() > 0 and vb.height() > 0:
        scale = min(size / vb.width(), size / vb.height())
        w, h = vb.width() * scale, vb.height() * scale
        svg.render(p, QRectF((size - w) / 2, (size - h) / 2, w, h))
    else:
        svg.render(p)
    p.end()

    qba = QByteArray()
    buf = QBuffer(qba)
    buf.open(QBuffer.OpenModeFlag.WriteOnly)
    img.save(buf, "PNG")
    buf.close()
    return Image.open(io.BytesIO(bytes(qba))).convert("RGBA")


def main(argv: list[str]) -> int:
    here = Path(__file__).resolve().parent
    svg_path = Path(argv[1]) if len(argv) > 1 else here / "assets" / "icon.svg"
    if not svg_path.is_file():
        print(f"[X] Introuvable : {svg_path}")
        print("    Depose ton dessin vectoriel sous ce nom, puis relance.")
        return 1

    out_dir = svg_path.parent
    ico_path = out_dir / "icon.ico"
    png_path = out_dir / "icon.png"

    _ = QGuiApplication.instance() or QGuiApplication([])
    renderer = QSvgRenderer(str(svg_path))
    if not renderer.isValid():
        print(f"[X] SVG illisible : {svg_path}")
        return 1

    imgs = [_render(renderer, s) for s in SIZES]
    imgs[-1].save(ico_path, format="ICO",
                  sizes=[(s, s) for s in SIZES],
                  append_images=imgs[:-1])
    imgs[-1].save(png_path, format="PNG")

    print(f"[OK] {ico_path}  ({', '.join(f'{s}' for s in SIZES)} px)")
    print(f"[OK] {png_path}  (256 px)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
