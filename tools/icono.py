"""Icono del Port Launcher: una Poké Ball (los ports de Pokémon) cuyo botón central es una Esfera del Dragón
de 4 estrellas (DB Survivors), sobre un fondo morado. Uso: python3 tools/icono.py."""
import math, os
from PIL import Image, ImageDraw, ImageFilter

S = 1024 * 2  # se dibuja al doble y se reduce: bordes suaves


def estrella(d, cx, cy, r, color):
    pts = []
    for i in range(10):
        a = -math.pi / 2 + i * math.pi / 5
        rr = r if i % 2 == 0 else r * 0.45
        pts.append((cx + rr * math.cos(a), cy + rr * math.sin(a)))
    d.polygon(pts, fill=color)


def dibujar(fondo=True):
    im = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    c = S / 2
    if fondo:
        # fondo: degradado morado en un cuadrado redondeado
        g = Image.new("RGBA", (S, S))
        gd = ImageDraw.Draw(g)
        for y in range(S):
            t = y / S
            gd.line([(0, y), (S, y)], fill=(int(58 - 30 * t), int(36 - 20 * t), int(110 - 60 * t), 255))
        m = Image.new("L", (S, S), 0)
        ImageDraw.Draw(m).rounded_rectangle((0, 0, S - 1, S - 1), int(S * 0.22), fill=255)
        im.paste(g, (0, 0), m)
        # destellos
        for (x, y, r) in [(0.18, 0.2, 0.035), (0.84, 0.16, 0.025), (0.86, 0.82, 0.03), (0.14, 0.84, 0.02)]:
            estrella(d, S * x, S * y, S * r, (255, 230, 140, 220))
    R = S * 0.36
    caja = (c - R, c - R, c + R, c + R)
    # sombra
    sh = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(sh).ellipse((c - R, c - R + S * 0.03, c + R, c + R + S * 0.03), fill=(0, 0, 0, 120))
    im.alpha_composite(sh.filter(ImageFilter.GaussianBlur(S * 0.02)))
    d = ImageDraw.Draw(im)
    borde = S * 0.028
    d.ellipse(caja, fill=(20, 16, 30, 255))
    ri = R - borde
    d.pieslice((c - ri, c - ri, c + ri, c + ri), 180, 360, fill=(232, 52, 64, 255))
    d.pieslice((c - ri, c - ri, c + ri, c + ri), 0, 180, fill=(245, 242, 250, 255))
    # brillo en la mitad roja
    d.chord((c - ri * 0.8, c - ri * 0.92, c + ri * 0.1, c - ri * 0.2), 200, 290, fill=(255, 120, 125, 255))
    d.rectangle((c - R, c - S * 0.03, c + R, c + S * 0.03), fill=(20, 16, 30, 255))
    # botón: aro oscuro y Esfera del Dragón
    rb = S * 0.13
    d.ellipse((c - rb, c - rb, c + rb, c + rb), fill=(20, 16, 30, 255))
    re_ = rb * 0.78
    esf = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ed = ImageDraw.Draw(esf)
    for i in range(60):  # degradado radial naranja
        t = i / 59
        r = re_ * (1 - t * 0.85)
        col = (int(235 + 20 * t), int(120 + 90 * t), int(20 + 60 * t), 255)
        off = re_ * 0.25 * t
        ed.ellipse((c - r - off, c - r - off, c + r - off, c + r - off), fill=col)
    m = Image.new("L", (S, S), 0)
    ImageDraw.Draw(m).ellipse((c - re_, c - re_, c + re_, c + re_), fill=255)
    im.paste(esf, (0, 0), m)
    d = ImageDraw.Draw(im)
    sr = re_ * 0.24
    for dx, dy in [(-0.32, -0.3), (0.32, -0.3), (-0.32, 0.32), (0.32, 0.32)]:
        estrella(d, c + dx * re_, c + dy * re_, sr, (215, 30, 30, 255))
    d.ellipse((c - re_ * 0.62, c - re_ * 0.7, c - re_ * 0.3, c - re_ * 0.42), fill=(255, 245, 220, 200))
    return im


raiz = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
grande = dibujar().resize((1024, 1024), Image.LANCZOS)
res = os.path.join(raiz, "android/app/src/main/res")
for q, s in [("mdpi", 48), ("hdpi", 72), ("xhdpi", 96), ("xxhdpi", 144), ("xxxhdpi", 192)]:
    os.makedirs(f"{res}/mipmap-{q}", exist_ok=True)
    grande.resize((s, s), Image.LANCZOS).save(f"{res}/mipmap-{q}/ic_launcher.png")
grande.resize((512, 512), Image.LANCZOS).save(os.path.join(raiz, "desktop/build/icon.png"))
grande.save(os.path.join(raiz, "desktop/build/icon.ico"), sizes=[(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)])
grande.resize((160, 160), Image.LANCZOS).save(os.path.join(raiz, "ui/iconos/launcher.png"))
grande.resize((256, 256), Image.LANCZOS).save("/home/claude/bf/icono.png")
print("ok")
