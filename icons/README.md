# Extension Icons

This folder contains the icon design for the Text to Calendar extension.

## Icon Design

The icon is a minimal calendar with:
- Google blue (#4285f4) as the primary color
- Darker blue header (#3367d6)
- White calendar page area
- Plus (+) symbol indicating "add event"

## Required Files

Chrome extensions need PNG icons in these sizes:
- `icon16.png` - 16x16 pixels (toolbar, context menu)
- `icon48.png` - 48x48 pixels (extensions page)
- `icon128.png` - 128x128 pixels (Chrome Web Store, install dialog)

## How to Export PNGs from SVG

### Option 1: Online Converter (Easiest)
1. Go to https://svgtopng.com/ or https://cloudconvert.com/svg-to-png
2. Upload `icon.svg`
3. Export at 16x16, 48x48, and 128x128 sizes
4. Save as `icon16.png`, `icon48.png`, `icon128.png`

### Option 2: Inkscape (Free Desktop App)
1. Open `icon.svg` in Inkscape
2. File → Export PNG Image
3. Set width/height to desired size (16, 48, or 128)
4. Click Export
5. Repeat for each size

### Option 3: Figma (Free Web App)
1. Create a new Figma file
2. Import `icon.svg` (drag and drop or File → Place Image)
3. Select the icon
4. In the right panel, click "Export"
5. Add three export settings: 16x, 48x, 128x (or set specific sizes)
6. Export all

### Option 4: ImageMagick (Command Line)
```bash
# Install ImageMagick first, then:
convert -background none icon.svg -resize 16x16 icon16.png
convert -background none icon.svg -resize 48x48 icon48.png
convert -background none icon.svg -resize 128x128 icon128.png
```

### Option 5: macOS Preview
1. Open `icon.svg` in a browser
2. Take a screenshot or save as PNG
3. Open in Preview
4. Tools → Adjust Size → set to each required size
5. Export as PNG

## After Exporting

Once you have the PNG files, update `manifest.json` to include:

```json
{
  "icons": {
    "16": "icons/icon16.png",
    "48": "icons/icon48.png",
    "128": "icons/icon128.png"
  },
  "action": {
    "default_popup": "popup.html",
    "default_icon": {
      "16": "icons/icon16.png",
      "48": "icons/icon48.png",
      "128": "icons/icon128.png"
    }
  }
}
```
