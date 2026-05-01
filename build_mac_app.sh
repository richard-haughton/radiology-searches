#!/bin/bash
set -euo pipefail

# Script to build macOS app for Radiology Assistant
# This script activates the conda environment and builds the app using PyInstaller

echo "Building Radiology Assistant macOS App..."
echo "=========================================="

# Activate conda environment
echo "Activating conda environment 'searches'..."
source "$(conda info --base)/etc/profile.d/conda.sh"
conda activate searches

# Check if pyinstaller is installed
if ! command -v pyinstaller &> /dev/null; then
    echo "PyInstaller not found. Installing..."
    pip install pyinstaller
fi

# Check if required dependencies are installed
echo "Checking dependencies..."
python -c "import openpyxl" 2>/dev/null || pip install openpyxl
python -c "import h5py" 2>/dev/null || pip install h5py

# Clean previous builds
echo "Cleaning previous builds..."
rm -rf build dist

# Build the app
echo "Building the app with PyInstaller..."
python -m PyInstaller radiology_assistant.spec

# Check if build was successful
if [ -d "dist/Searches.app" ]; then
    echo "Creating distributable zip..."
    rm -f dist/Searches-macOS.zip
    ditto -c -k --sequesterRsrc --keepParent "dist/Searches.app" "dist/Searches-macOS.zip"

    echo ""
    echo "=========================================="
    echo "✓ Build successful!"
    echo "=========================================="
    echo ""
    echo "Your app is located at:"
    echo "  $(pwd)/dist/Searches.app"
    echo ""
    echo "To install:"
    echo "  1. Open Finder and navigate to $(pwd)/dist/"
    echo "  2. Drag Searches.app to your Applications folder"
    echo ""
    echo "Or use this command:"
    echo "  cp -r dist/Searches.app /Applications/"
    echo ""
    echo "Distributable zip:"
    echo "  $(pwd)/dist/Searches-macOS.zip"
    echo ""

    if [ -f "prepare_website_release.sh" ]; then
        echo "Staging website download assets..."
        chmod +x prepare_website_release.sh
        ./prepare_website_release.sh || true
        echo ""
        echo "Website files ready in: $(pwd)/website/"
        echo ""
    fi
else
    echo ""
    echo "=========================================="
    echo "✗ Build failed. Check the output above for errors."
    echo "=========================================="
    exit 1
fi
