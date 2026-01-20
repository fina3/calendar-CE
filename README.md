# Text to Calendar

A Chrome extension that lets you highlight any text on a webpage, right-click, and instantly create a Google Calendar event with intelligently parsed date, time, and duration.

## Features

- **Smart Text Parsing**: Automatically extracts dates, times, and durations from natural language
- **Context Menu Integration**: Right-click any selected text to create an event
- **Event History**: View and re-create your last 5 events from the popup
- **Session Badge**: Shows how many events you've created this session
- **Confidence Scoring**: Visual indicator of how well the text was parsed
- **No Account Required**: Uses Google Calendar's public URL scheme

## Installation

### Load as Unpacked Extension (Development)

1. Download or clone this repository
2. Open Chrome and navigate to `chrome://extensions/`
3. Enable **Developer mode** (toggle in the top right)
4. Click **Load unpacked**
5. Select the `text-to-calendar-extension` folder
6. The extension icon should appear in your toolbar

### Generate Icons (Optional)

The extension includes an SVG icon design. To generate PNG icons:

1. Open `icons/icon.svg` in a browser or image editor
2. Export as PNG at 16x16, 48x48, and 128x128 pixels
3. Save as `icon16.png`, `icon48.png`, `icon128.png` in the `icons/` folder

See `icons/README.md` for detailed export instructions.

## Usage

### Creating an Event

1. **Select text** on any webpage that describes an event
2. **Right-click** to open the context menu
3. Click **"📅 Create Calendar Event"**
4. Google Calendar opens with the event pre-filled
5. Review and click **Save** in Google Calendar

### Example Texts

The extension intelligently parses various formats:

| Text | Parsed Result |
|------|---------------|
| `Meeting with John tomorrow at 3pm` | Tomorrow, 3:00 PM, 1 hour |
| `Doctor appointment January 15, 2025 at 10:30 AM for 45 minutes` | Jan 15 2025, 10:30 AM, 45 min |
| `Team standup next Monday morning` | Next Monday, 9:00 AM, 1 hour |
| `Call mom` | Next hour, 1 hour (defaults) |
| `Lunch with Sarah on Friday at noon` | This Friday, 12:00 PM, 1 hour |
| `Project deadline 2025-01-30` | Jan 30 2025, 9:00 AM, 1 hour |
| `2 hour workshop on React basics` | Next hour, 2 hours |
| `Meeting at 2pm until 4pm` | Today/Tomorrow 2 PM, 2 hours |

### Supported Date Formats

- **Relative**: `today`, `tomorrow`, `day after tomorrow`
- **Day names**: `Monday`, `next Tuesday`, `this Friday`
- **Month/Day**: `January 5`, `Jan 5th`, `5 January`
- **Full dates**: `January 5, 2025`, `01/15/2025`, `2025-01-15`
- **Next week**: `next week`

### Supported Time Formats

- **12-hour**: `3pm`, `3:30 PM`, `10:30 AM`
- **24-hour**: `15:00`, `09:30`
- **Named**: `noon`, `midnight`
- **Descriptive**: `morning` (9 AM), `afternoon` (2 PM), `evening` (6 PM)
- **Informal**: `at 3` (assumes PM for 1-7)

### Supported Duration Formats

- **Explicit**: `for 2 hours`, `for 30 minutes`, `for 1.5 hrs`
- **Until**: `until 5pm` (calculates from start time)
- **Contextual**: `2 hour meeting`, `30 minute call`
- **Default**: 1 hour if not specified

### Using the Popup

Click the extension icon to:
- View recent events you've created
- See the confidence score for each parsed event
- Click **"Create Again"** to re-open an event in Google Calendar
- Click **"Clear History"** to remove all saved events

## Screenshots

*Coming soon*

<!--
![Context Menu](screenshots/context-menu.png)
![Popup](screenshots/popup.png)
![Calendar Result](screenshots/calendar.png)
-->

## Known Limitations

1. **Time Zone**: Events are created in your local time zone
2. **Date Ambiguity**: `01/02/2025` is parsed as January 2nd (US format), not February 1st
3. **No Location Parsing**: Location/address detection is not implemented
4. **No Recurring Events**: Only single events can be created
5. **Google Calendar Only**: Does not support other calendar applications
6. **Requires Sign-in**: You must be signed into Google Calendar in your browser

## Future Improvements

- [ ] Location/address detection and Google Maps integration
- [ ] Support for recurring events (`every Monday`, `weekly`)
- [ ] Outlook and Apple Calendar support
- [ ] Attendee detection (email addresses in text)
- [ ] Custom default duration setting
- [ ] Keyboard shortcut to create event
- [ ] Support for multiple languages
- [ ] Timezone specification in text
- [ ] Integration with Google Calendar API for direct event creation

## Development

### Project Structure

```
text-to-calendar-extension/
├── manifest.json      # Extension configuration
├── background.js      # Service worker (text parsing, event handling)
├── popup.html         # Popup UI structure
├── popup.js           # Popup functionality
├── popup.css          # Popup styles
├── icons/
│   ├── icon.svg       # Source icon design
│   └── README.md      # Icon export instructions
└── README.md          # This file
```

### Building from Source

```bash
# Install dependencies
npm install

# Run linting
npm run lint

# Auto-fix linting issues
npm run lint:fix

# Build extension zip (outputs to dist/)
npm run build
```

The build script creates a zip file in `dist/` that can be uploaded to the Chrome Web Store.

### Creating a Release

To create a new release:

1. Update the version in `manifest.json`
2. Commit your changes
3. Create and push a tag:
   ```bash
   git tag v1.0.1
   git push origin v1.0.1
   ```
4. GitHub Actions will automatically create a release with the extension zip

### Enabling Debug Mode

To enable detailed console logging, edit `background.js` and set:

```javascript
const CONFIG = {
  DEBUG: true,  // Change from false to true
  // ...
};
```

Then reload the extension and check the service worker console in `chrome://extensions/`.

### Testing

1. Load the extension in Chrome
2. Navigate to any webpage with text
3. Select text containing date/time information
4. Right-click and select "📅 Create Calendar Event"
5. Verify the Google Calendar event is pre-filled correctly

### Running Tests (Manual)

Test these example phrases:
- ✅ `Meeting with John tomorrow at 3pm`
- ✅ `Doctor appointment January 15, 2025 at 10:30 AM for 45 minutes`
- ✅ `Team standup next Monday morning`
- ✅ `Call mom`

## License

MIT License - feel free to use and modify.

## Contributing

Contributions welcome! Please open an issue or pull request.
