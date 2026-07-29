from PIL import Image, ImageDraw, ImageFont

PINK = (252, 98, 101)
YELLOW = (255, 201, 60)
PINK_LIGHT = (255, 217, 218)
PINK_BORDER = (255, 205, 206)
CARD_BG = (255, 245, 245)
OPUS_BG = (255, 240, 240)
TEXT_DARK = (51, 51, 51)
TEXT_GRAY = (102, 102, 102)
WHITE = (255, 255, 255)

SCALE = 3

def font(path, size):
    return ImageFont.truetype(path, size * SCALE)

F_BOLD = r"C:\Windows\Fonts\meiryob.ttc"
F_REG = r"C:\Windows\Fonts\meiryo.ttc"

def rounded(draw, box, radius, **kw):
    draw.rounded_rectangle(box, radius=radius, **kw)

def hgrad(size, c1, c2):
    w, h = size
    base = Image.new("RGB", (w, h), c1)
    top = Image.new("RGB", (w, h), c2)
    mask = Image.new("L", (w, h))
    mask.putdata([int(255 * (x / (w - 1))) for _y in range(h) for x in range(w)])
    base.paste(top, (0, 0), mask)
    return base

def diag_grad(size, c1, c2):
    w, h = size
    base = Image.new("RGB", (w, h), c1)
    top = Image.new("RGB", (w, h), c2)
    mask = Image.new("L", (w, h))
    data = []
    for y in range(h):
        for x in range(w):
            t = (x / w * 0.5 + y / h * 0.5)
            data.append(int(255 * t))
    mask.putdata(data)
    base.paste(top, (0, 0), mask)
    return base

W_CARD = 300
HEAD_H = 46
ITEM_H = 84
ITEM_GAP_TOP = 12
FOOTER_H = 38

def build_widget():
    n_items = 3
    content_h = HEAD_H + ITEM_GAP_TOP + ITEM_H * n_items + FOOTER_H
    W, H = W_CARD * SCALE, content_h * SCALE
    card = Image.new("RGBA", (W, H), (0, 0, 0, 0))

    base = Image.new("RGB", (W, H), WHITE)
    mask = Image.new("L", (W, H), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, W - 1, H - 1], radius=12 * SCALE, fill=255)
    card.paste(base, (0, 0), mask)
    draw = ImageDraw.Draw(card)
    rounded(draw, [0, 0, W - 1, H - 1], 12 * SCALE, outline=PINK_BORDER, width=SCALE)

    head_h_px = HEAD_H * SCALE
    head_grad = diag_grad((W, head_h_px), PINK, YELLOW)
    head_mask = Image.new("L", (W, head_h_px), 0)
    hd = ImageDraw.Draw(head_mask)
    hd.rounded_rectangle([0, 0, W - 1, head_h_px * 2], radius=12 * SCALE, fill=255)
    card.paste(head_grad, (0, 0), head_mask)

    fbold15 = font(F_BOLD, 15)
    draw.text((14 * SCALE, 14 * SCALE), "Claude使用量", font=fbold15, fill=WHITE)

    fctl = font(F_REG, 15)
    draw.text((W - 78 * SCALE, 13 * SCALE), "\u21bb", font=fctl, fill=WHITE)
    draw.text((W - 52 * SCALE, 13 * SCALE), "\u2212", font=fctl, fill=WHITE)
    draw.text((W - 30 * SCALE, 13 * SCALE), "\u00d7", font=fctl, fill=WHITE)

    items = [
        ("Current Session（現在のセッション）", 11, "2時間3分後", False),
        ("All Models（すべてのモデル）", 66, "22:00 (水)", False),
        ("Fable（週次・モデル別）", 2, "22:00 (水)", True),
    ]
    y = head_h_px + ITEM_GAP_TOP * SCALE
    item_h_px = ITEM_H * SCALE
    pad = 12 * SCALE
    for label, pct, reset, opus in items:
        x0, x1 = pad, W - pad
        bg = OPUS_BG if opus else CARD_BG
        border = PINK if opus else PINK_BORDER
        rounded(draw, [x0, y, x1, y + item_h_px - 8 * SCALE], 8 * SCALE, fill=bg, outline=border, width=SCALE)

        flabel = font(F_REG, 11.3)
        draw.text((x0 + 10 * SCALE, y + 10 * SCALE), label, font=flabel, fill=TEXT_GRAY)

        bar_x0, bar_x1 = x0 + 10 * SCALE, x1 - 10 * SCALE
        bar_y = y + 34 * SCALE
        bar_h = 6 * SCALE
        rounded(draw, [bar_x0, bar_y, bar_x1, bar_y + bar_h], 3 * SCALE, fill=PINK_LIGHT)
        fill_w = int((bar_x1 - bar_x0) * pct / 100)
        if fill_w > 0:
            fill_grad = hgrad((fill_w, bar_h), PINK, YELLOW)
            fm = Image.new("L", (fill_w, bar_h), 0)
            ImageDraw.Draw(fm).rounded_rectangle([0, 0, fill_w - 1, bar_h - 1], radius=3 * SCALE, fill=255)
            card.paste(fill_grad, (bar_x0, bar_y), fm)

        fpct = font(F_BOLD, 12)
        freset = font(F_REG, 12)
        draw.text((bar_x0, bar_y + 14 * SCALE), f"{pct}%", font=fpct, fill=TEXT_DARK)
        rb = draw.textbbox((0, 0), reset, font=freset)
        draw.text((bar_x1 - (rb[2] - rb[0]), bar_y + 14 * SCALE), reset, font=freset, fill=TEXT_GRAY)

        y += item_h_px

    draw.line([pad, y - 2 * SCALE, W - pad, y - 2 * SCALE], fill=PINK_BORDER, width=SCALE)
    ffoot = font(F_REG, 11)
    foot_text = "最終更新: 15:16"
    fb = draw.textbbox((0, 0), foot_text, font=ffoot)
    draw.text(((W - (fb[2] - fb[0])) / 2, y + 8 * SCALE), foot_text, font=ffoot, fill=TEXT_GRAY)

    card = card.resize((W_CARD, content_h), Image.LANCZOS)
    return card

def build_framed(widget_img):
    CW, CH = 640, 400
    canvas = Image.new("RGB", (CW, CH), (245, 243, 239))
    draw = ImageDraw.Draw(canvas)

    top_bar = 28
    bottom_bezel = 22
    side_bezel = 22
    frame_w = widget_img.width + side_bezel * 2
    frame_h = widget_img.height + top_bar + bottom_bezel
    fx0 = (CW - frame_w) // 2
    fy0 = (CH - frame_h) // 2
    fx1, fy1 = fx0 + frame_w, fy0 + frame_h
    rounded(draw, [fx0, fy0, fx1, fy1], 18, fill=(30, 30, 32))

    ty = fy0 + 15
    for i, col in enumerate([(255, 95, 87), (254, 188, 46), (40, 200, 64)]):
        cx = fx0 + 18 + i * 18
        draw.ellipse([cx - 5, ty - 5, cx + 5, ty + 5], fill=col)

    wx = fx0 + side_bezel
    wy = fy0 + top_bar
    canvas.paste(widget_img, (wx, wy))
    print("frame", fx0, fy0, fx1, fy1, "widget bottom", wy + widget_img.height, "vs frame bottom", fy1)

    return canvas

widget = build_widget()
print("widget size", widget.size)
widget.save(r"C:\Users\tmapk\Desktop\KOMATSUBARA\claude-usage-chatwork\dist\screenshot_raw.png")

framed = build_framed(widget)
framed.save(r"C:\Users\tmapk\Desktop\KOMATSUBARA\claude-usage-chatwork\dist\screenshot_640x400.png")
print("done")
