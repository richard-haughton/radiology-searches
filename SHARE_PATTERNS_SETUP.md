# Share Patterns Feature - Setup Guide

## Prerequisites

- Active Firebase project with Firestore database
- Google Authentication enabled
- Users already authenticated via Google Sign-In

## Step 1: Update Firestore Security Rules

1. Go to your Firebase Console (https://console.firebase.google.com)
2. Select your project
3. Navigate to **Firestore Database** → **Rules** tab
4. Replace the current rules with the following:

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // Verify user is authenticated
    match /users/{userId} {
      // Users can read and write their own data
      allow read, write: if request.auth.uid == userId;

      // Patterns collection within user document
      match /patterns/{patternId} {
        allow read, write: if request.auth.uid == userId;
      }

      // Study log collection within user document
      match /studyLog/{entryId} {
        allow read, write: if request.auth.uid == userId;
      }
    }

    // Shared Patterns Collection - NEW
    match /sharedPatterns/{docId} {
      // Anyone authenticated can read shared patterns
      allow read: if request.auth != null;
      
      // Only authenticated users can create shares
      allow create: if request.auth != null &&
                       request.resource.data.authorId == request.auth.uid &&
                       request.resource.data.patternId != null &&
                       request.resource.data.patternName != null &&
                       request.resource.data.modality != null &&
                       request.resource.data.sharedAt != null &&
                       request.resource.data.importCount == 0;
      
      // Users can update their own shares (increment import count only)
      allow update: if request.auth != null &&
                       resource.data.authorId == request.auth.uid &&
                       request.resource.data.diff(resource.data)
                          .affectedKeys().hasOnly(['importCount']);
      
      // Users can only delete their own shares
      allow delete: if request.auth != null &&
                       resource.data.authorId == request.auth.uid;
    }
  }
}
```

5. Click **Publish** to apply the rules

## Step 2: Verify the Implementation

After deploying, verify that the sharing feature is working:

1. **Test Pattern Sharing**:
   - Navigate to the "Share Patterns" tab
   - Select a pattern from your library
   - Click "Share Pattern"
   - You should see it appear in "Your Shared Patterns"

2. **Test Pattern Discovery**:
   - In the "Discover Shared Patterns" section
   - You should see patterns shared by other users
   - Try filtering by modality or searching

3. **Test Pattern Import**:
   - Click "Import Pattern" on a shared pattern
   - Go to "Search Patterns" tab
   - Verify the pattern appears in your library

## Firestore Security Rules Explanation

### Read Rules
- Authenticated users can read all shared patterns
- This enables browsing the community library

### Create Rules
- Only authenticated users can create shares
- `authorId` must match the current user's UID
- Prevents unauthorized shares
- `patternId`, `patternName`, `modality`, and `sharedAt` are required
- `importCount` must be 0 initially

### Update Rules
- Users can only update their own patterns (by authorId match)
- Only `importCount` field can be modified
- Prevents unauthorized changes to pattern metadata

### Delete Rules
- Users can only delete their own shares
- Pattern is removed from discovery list

## Troubleshooting

### "Permission Denied" Error When Sharing
**Problem**: Users get a permission error when trying to share a pattern

**Solution**:
- Check Firestore security rules are correctly deployed
- Ensure user is authenticated (check Firebase Auth)
- Verify the pattern has all required fields (name, modality, etc.)

**Test**:
```
1. Open browser DevTools (F12)
2. Go to Console tab
3. Check for error messages
4. Look for "Permission denied" in red text
```

### Can't See Shared Patterns in Discovery
**Problem**: The discovery section shows "No shared patterns found"

**Solution**:
- Ask another user to share a pattern first
- Check that sharedPatterns collection exists in Firestore
- Verify read rules are correct (should allow authenticated read)

**Test**:
```
1. Go to Firebase Console
2. Check Firestore → Data tab
3. Look for sharedPatterns collection
4. Verify documents exist there
```

### Import Button is Disabled
**Problem**: "Already Imported" shows when it shouldn't

**Solution**:
- This is normal if you already imported the pattern
- Check your "Search Patterns" tab to see if the pattern is there
- If it's not there but still shows disabled, clear browser cache

**Test**:
```
1. Go to "Search Patterns" tab
2. Search for the pattern name
3. If found, you already have it
```

### Firestore Shows Error After Publishing Rules
**Problem**: Rules fail to publish with a syntax error

**Solution**:
- Check the error message at the bottom of the rules editor
- Copy the rules exactly as provided (watch for quotes and syntax)
- Try publishing again

**Test**:
```
1. Click the syntax check icon (✓) in the rules editor
2. It will show any syntax errors
```

## Integration Checklist

- [x] HTML tab added ("Share Patterns")
- [x] JavaScript module created (share-patterns.js)
- [x] CSS styling added
- [x] App.js initialization updated
- [ ] Firestore security rules deployed
- [ ] Test sharing feature works
- [ ] Test importing feature works

## Files Modified

1. **website/index.html**
   - Added "Share Patterns" tab button
   - Added share patterns panel HTML
   - Added share-patterns.js script tag

2. **website/js/share-patterns.js**
   - New module (created)
   - Handles all sharing functionality

3. **website/css/app.css**
   - Added share-patterns styling
   - Added responsive layout styles

4. **website/js/app.js**
   - Added initSharePatterns() call

## Feature Summary

✅ Users can share their custom search patterns
✅ Real-time discovery of community patterns
✅ Filter and search shared patterns
✅ Import patterns directly to personal library
✅ Track pattern import counts
✅ Unshare patterns anytime
✅ Security via Firestore rules and authentication

## Next Steps

1. Update Firestore security rules (see Step 1)
2. Deploy the updated rules
3. Test the sharing feature
4. Share with other users to build the community library

For more details, see [SHARE_PATTERNS.md](./SHARE_PATTERNS.md)
