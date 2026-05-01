# -*- mode: python ; coding: utf-8 -*-

added_files = [
    ('dist_templates/radiology_search_patterns.h5', '.'), 
    ('RVUS.xlsx', '.'), 
    ('search_patterns.py', '.'),
    ('dist_templates/study_times.csv', '.')  
]

a = Analysis(
    ['radiology_assistant.py'],
    pathex=[],
    binaries=[],
    datas=added_files,
    hiddenimports=['PIL', 'PIL._imagingtk', 'PIL._tkinter_finder', 'openpyxl', 'pandas', 'numpy', 'h5py', 'ollama', 'openai'],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='Searches',  
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,  
    console=False,
    disable_windowed_traceback=False,
    icon='Searches.icns'  
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name='Searches',
)

app = BUNDLE(
    coll,
    name='Searches.app',
    icon='Searches.icns',
    bundle_identifier='com.radiology.searches',
    info_plist={
        'NSHighResolutionCapable': 'True',
        'CFBundleShortVersionString': '1.0.0',
        'CFBundleVersion': '1.0.0',
        'NSHumanReadableCopyright': 'Copyright © 2026',
        'LSMinimumSystemVersion': '10.13.0',
    },
)