# Radiology Assistant - macOS App

## Installation

### Quick Install
1. Open Finder and navigate to `dist/Searches.app`
2. Drag `Searches.app` to your Applications folder
3. Double-click the app to launch

Or use Terminal:
```bash
cp -r dist/Searches.app /Applications/
open /Applications/Searches.app
```

### First Launch
When you first launch the app, macOS may show a security warning because the app is not from the App Store. To open it:

1. Right-click (or Control+click) on `Searches.app`
2. Select "Open" from the menu
3. Click "Open" in the dialog that appears

## Features

The macOS app includes full functionality for:

### File Operations
- **study_times.csv**: Read and edit study times
  - Data is stored in `~/.radiology_assistant/study_times.csv`
  - Changes are automatically saved
   - Initial file is a blank, header-only template copied on first launch

- **radiology_search_patterns.h5**: Search pattern storage and import/export format
   - Data is stored in `~/.radiology_assistant/radiology_search_patterns.h5`
   - Initial file is a blank template copied on first launch
   - Users can import their own `.h5` from the File menu

- **RVUS.xlsx**: Excel file operations
  - Bundled with the app for RVU calculations
  - Accessible through the application via resource paths

### Application Icon
- Uses `Searches.icns` for native macOS appearance
- High-resolution support enabled

## User Data Location

The app stores user-editable data in:
```
~/.radiology_assistant/
├── study_times.csv
├── radiology_search_patterns.h5
└── pattern_edits/
```

This ensures:
- Data persists between app updates
- Multiple users can have separate data
- App bundle remains clean and portable

## File Path Handling

The app uses two path strategies:

1. **Read-only resources** (via `get_resource_path()`):
   - `RVUS.xlsx` - bundled RVU data
   - Template files

2. **User-writable data** (via `get_data_path()`):
   - `study_times.csv` - study log data
   - `radiology_search_patterns.h5` - editable/importable pattern library
   - `pattern_edits/` - pattern modifications

## Website Distribution

Use the static site under `website/` as your dedicated distribution page.

1. Build the app zip (creates `dist/Searches-macOS.zip`).
2. Run:
   ```bash
   ./prepare_website_release.sh
   ```
3. Upload the `website/` folder to your hosting provider.

This copies these release assets into `website/downloads/`:
- `Searches-macOS.zip`
- `radiology_search_patterns.h5` (blank starter template)
- `study_times.csv` (blank starter template)
- `SHA256SUMS.txt` (generated checksum file)

## Rebuilding the App

If you need to rebuild the app:

1. Activate the conda environment:
   ```bash
   conda activate searches
   ```

2. Clean previous builds:
   ```bash
   rm -rf build dist
   ```

3. Build the app:
   ```bash
   pyinstaller radiology_assistant.spec
   ```

The built app will be in `dist/Searches.app`

## Technical Details

### Build Configuration
- **Python**: 3.14.2 (conda environment: searches)
- **Build Tool**: PyInstaller 6.18.0
- **Architecture**: arm64 (Apple Silicon)
- **Bundle ID**: com.radiology.searches

### Included Dependencies
- tkinter (GUI framework)
- pandas (data processing)
- openpyxl (Excel file handling)
- PIL/Pillow (image handling)
- numpy (numerical operations)
- ollama (optional AI integration)
- openai (optional AI integration)

### Console Mode
The app runs without a console window (`console=False` in spec file) for a clean macOS experience.

## Recent Fixes (Jan 22, 2026)

Fixed file path handling for bundled app:
- ✅ `study_times.csv` now loads correctly using `get_data_path()`
- ✅ `RVUS.xlsx` now loads correctly using `get_resource_path()`
- ✅ `radiology_search_patterns.py` uses `get_data_path()` for editing
- ✅ All pattern edits save to user directory

## Troubleshooting

### Study times not loading
- Check if `~/.radiology_assistant/study_times.csv` exists
- If not, the app will copy the template from the bundle on first access
- Try restarting the app

### RVU data not available
- Verify `RVUS.xlsx` is bundled in app Resources
- Check: Right-click app → Show Package Contents → Contents → Resources

### Pattern edits not saving
- Verify write permissions: `ls -la ~/.radiology_assistant/`
- Check that directory exists: `mkdir -p ~/.radiology_assistant/`

### App won't open
- Make sure you've right-clicked and selected "Open" the first time
- Check System Settings > Privacy & Security for any blocks

### Data not persisting
- Verify `~/.radiology_assistant/` directory exists
- Check file permissions: `ls -la ~/.radiology_assistant/`

### Rebuilding issues
- Ensure conda environment is activated: `conda activate searches`
- Verify PyInstaller is installed: `pip install pyinstaller`
- Check all data files exist before building

## Version Information
- **Version**: 1.0.1
- **Build Date**: January 22, 2026
- **Minimum macOS**: 10.13.0 (High Sierra)

## Support

For issues or questions, check:
1. Build warnings: `build/radiology_assistant/warn-radiology_assistant.txt`
2. Build graph: `build/radiology_assistant/xref-radiology_assistant.html`
