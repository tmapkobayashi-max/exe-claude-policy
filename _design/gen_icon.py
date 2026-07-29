from PIL import Image, ImageDraw, ImageFont
import math

PINK = (252, 98, 101)      # #FC6265 - exemate brand main color (from site + logo)
YELLOW = (255, 201, 60)    # #FFC93C - accent

SIZE = 1024
SS = 4  # supersample factor for the corner-radius mask master (not text)

def make_gradient(size, c1, c2):
    """Diagonal gradient top-left (c1) -> bottom-right (c2)."""
    base = Image.new("RGB", (size, size), c1)
    top = Image.new("RGB", (size, size), c2)
    mask = Image.new("L", (size, size))
    mdata = []
    for y in range(size):
        for x in range(size):
            # diagonal progress 0..1
            t = (x + y) / (2 * (size - 1))
            mdata.append(int(255 * t))
    mask.putdata(mdata)
    base.paste(top, (0, 0), mask)
    return base

def rounded_mask(size, radius):
    mask = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(mask)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return mask

def build_icon(size, letter="C"):
    grad = make_gradient(size, PINK, YELLOW)
    radius = int(size * 0.22)
    mask = rounded_mask(size, radius)
    icon = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    icon.paste(grad, (0, 0), mask)

    draw = ImageDraw.Draw(icon)
    font_path = r"C:\Windows\Fonts\segoeuib.ttf"
    font_size = int(size * 0.58)
    font = ImageFont.truetype(font_path, font_size)
    bbox = draw.textbbox((0, 0), letter, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    tx = (size - tw) / 2 - bbox[0]
    ty = (size - th) / 2 - bbox[1]
    draw.text((tx, ty), letter, font=font, fill=(255, 255, 255, 255))
    return icon

master = build_icon(SIZE)
master.save(r"C:\Users\tmapk\Desktop\KOMATSUBARA\claude-usage-chatwork\icons\_master_1024.png")

for out_size in (128, 48, 16):
    resized = master.resize((out_size, out_size), Image.LANCZOS)
    resized.save(rf"C:\Users\tmapk\Desktop\KOMATSUBARA\claude-usage-chatwork\icons\icon{out_size}.png")

print("done")
