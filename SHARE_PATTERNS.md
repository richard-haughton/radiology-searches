# Share Patterns Feature

## Overview

The Share Patterns feature allows users to share their custom search patterns with the community. Other users can discover, preview, and import shared patterns into their own library.

## Features

### Share Your Patterns
- **Select & Share**: Users can browse their own patterns and share them with one click
- **Import Tracking**: The system tracks how many times each pattern has been imported
- **Manage Shares**: Users can view all their shared patterns and unshare any of them at any time

### Discover Shared Patterns
- **Browse Community Patterns**: Users can see all patterns shared by other radiologists
- **Filter & Search**: 
  - Filter by modality (CT, MRI, US, XR, NM)
  - Search by pattern name or author name
- **Import Patterns**: Import any shared pattern directly into your personal library
- **Prevent Duplicates**: Already-imported patterns show a disabled "Already Imported" button

## Data Structure

### Shared Patterns Collection
```
/sharedPatterns/{docId}
├── patternId: string (ID of the original pattern)
├── patternName: string (Name of the pattern)
├── modality: string (CT, MRI, US, Plain Radiograph, Nuclear Medicine, Other)
├── authorId: string (UID of the user who shared it)
├── authorName: string (Display name of the author)
├── sharedAt: timestamp (When the pattern was shared)
└── importCount: number (How many times it's been imported)
```

## How It Works

### Sharing a Pattern

1. User navigates to the "Share Patterns" tab
2. Selects a pattern from their "Patterns to Share" dropdown
3. Clicks "Share Pattern"
4. The pattern is added to the `sharedPatterns` collection with metadata
5. The pattern appears in the user's "Your Shared Patterns" section
6. Other users can now discover and import it

### Importing a Pattern

1. User browses the "Discover Shared Patterns" section
2. Can filter by modality or search by name/author
3. Clicks "Import Pattern" on a shared pattern
4. The original pattern is copied to the user's personal patterns collection
5. The import count for that pattern is incremented
6. The pattern now appears in the user's "Search Patterns" tab

### Unsharing a Pattern

1. User can unshare any of their patterns by clicking "Unshare" in their shared patterns list
2. The share record is deleted from the collection
3. Users who previously imported it still have their copy

## Firestore Security Rules

To enable the sharing feature, add the following security rules to your Firestore database:

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // ... existing rules ...

    // Shared Patterns Collection
    match /sharedPatterns/{document=**} {
      // Anyone can read shared patterns
      allow read: if request.auth != null;
      
      // Only authenticated users can create shares
      allow create: if request.auth != null &&
                       request.resource.data.authorId == request.auth.uid &&
                       request.resource.data.patternId != null &&
                       request.resource.data.patternName != null &&
                       request.resource.data.modality != null &&
                       request.resource.data.sharedAt != null &&
                       request.resource.data.importCount == 0;
      
      // Users can only update their own shares (increment import count)
      allow update: if request.auth != null &&
                       resource.data.authorId == request.auth.uid &&
                       request.resource.data.diff(resource.data).affectedKeys()
                          .hasOnly(['importCount']);
      
      // Users can only delete their own shares
      allow delete: if request.auth != null &&
                       resource.data.authorId == request.auth.uid;
    }

    // ... rest of existing rules ...
  }
}
```

## Implementation Details

### Frontend Components

1. **HTML Tab**: Added "Share Patterns" tab in the main navigation
2. **share-patterns.js**: Main module handling all sharing functionality
3. **CSS Styles**: Added styling for the share interface in app.css

### Key Functions

- `initSharePatterns(userId)`: Initialize the sharing module
- `subscribePatterns(uid, callback)`: Get user's own patterns
- `subscribeSharedPatterns(callback)`: Get all shared patterns
- `sharePattern(patternId)`: Share a user's pattern
- `unsharePattern(patternId)`: Remove a share
- `importSharedPattern(patternId, patternName)`: Import a shared pattern
- `applyShareFilters()`: Filter shared patterns by modality and search text

### Real-time Updates

Both the "Your Shared Patterns" and "Discover Shared Patterns" sections use Firestore listeners to update in real-time as:
- New patterns are shared by other users
- Patterns are imported (import count updates)
- Shares are removed

## User Flow

### Sharing a Pattern

```
User views "Share Patterns" tab
    ↓
Selects a pattern from dropdown
    ↓
Clicks "Share Pattern"
    ↓
Pattern uploaded to sharedPatterns collection
    ↓
Pattern appears in "Your Shared Patterns"
    ↓
Other users can discover and import
```

### Discovering and Importing

```
User navigates to "Discover Shared Patterns"
    ↓
Optionally filters by modality or searches
    ↓
Browses shared patterns from community
    ↓
Clicks "Import Pattern"
    ↓
Pattern copied to user's patterns collection
    ↓
Pattern now available in user's patterns
```

## Future Enhancements

Potential improvements for future versions:

1. **Ratings & Reviews**: Allow users to rate and review shared patterns
2. **Favorites**: Users can favorite patterns for quick access
3. **Pattern Categories**: Organize patterns by anatomy or pathology
4. **Comments**: Allow discussions on shared patterns
5. **Usage Statistics**: Show trending patterns
6. **Export/Backup**: Let users export their imported patterns
7. **Permissions**: Control who can import your patterns (public/private)
8. **Version Control**: Track pattern edits and revisions

## Troubleshooting

### "Permission Denied" Error When Sharing
- Ensure the user is authenticated
- Check Firebase security rules are properly configured
- Verify the pattern data is valid (has name, modality, etc.)

### Can't See Other Users' Patterns
- Check your read permission in Firestore security rules
- Verify the other users have successfully shared patterns
- Refresh the page to trigger the Firestore listener

### Import Not Working
- Ensure you don't already have the pattern
- Check that the original author's pattern still exists
- Verify you have write permissions to your own patterns collection

## Data Privacy

- **Pattern Sharing**: Only the pattern structure and metadata are shared, not user information
- **Author Information**: Only the display name (from Google profile) is shown
- **Firestore Rules**: Security rules prevent unauthorized access or modification

## Notes

- When a pattern is imported, it creates a complete copy in the importing user's collection
- Modifying an imported pattern only affects the copy, not the original
- Sharing a pattern doesn't prevent the original author from editing it
- Users can share unlimited patterns
