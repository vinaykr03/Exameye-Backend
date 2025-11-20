# Database Schema Fix for Violations Table

## Problem
The same student (e.g., Vinay) appearing in different subject codes or exam sessions was causing violations and photos to be mixed together in the admin dashboard, student violations view, and export functionality.

## Solution
This migration adds database-level constraints and triggers to ensure:
1. **Consistency**: When both `exam_id` and `student_id` are present in a violation, they must match (the student_id must belong to the exam)
2. **Auto-population**: Missing `exam_id` or `student_id` are automatically populated when possible
3. **Performance**: Composite indexes for faster queries on exam_id + student_id combinations
4. **Data Quality**: Views and functions to identify and fix data inconsistencies

## Migration Files

### 1. `20251120000000_fix_violations_exam_student_consistency.sql`
Main migration that adds:
- Composite indexes for better query performance
- Trigger function to validate and auto-populate exam_id/student_id
- Helper function to fix existing data
- Views to identify data issues
- Materialized view for faster reporting

### 2. `20251120000001_fix_existing_violations_data.sql` (Optional)
Run this AFTER the main migration to fix existing data:
- Links violations with missing exam_id to appropriate exam sessions
- Fixes violations where exam_id and student_id don't match
- Updates violations with missing student_id

## How to Apply

### Option 1: Using Supabase CLI
```bash
cd Exameye-Shield-frontend--main
supabase migration up
```

### Option 2: Using Supabase Dashboard
1. Go to your Supabase project dashboard
2. Navigate to SQL Editor
3. Copy and paste the contents of `20251120000000_fix_violations_exam_student_consistency.sql`
4. Run the migration
5. (Optional) Run `20251120000001_fix_existing_violations_data.sql` to fix existing data

### Option 3: Manual Application
Run the SQL files in order using your database client.

## What Gets Fixed

### Automatic Fixes (via Trigger)
- When inserting a violation with both `exam_id` and `student_id`, the trigger validates they match
- If `exam_id` is provided but `student_id` is missing, it auto-populates `student_id` from the exam
- If `student_id` is provided but `exam_id` is missing, it tries to find the most recent exam for that student

### Manual Fixes (via Function)
You can run the helper function to fix existing data:
```sql
SELECT * FROM fix_violations_exam_links();
```

This will return:
- `violations_fixed`: Number of violations that were fixed
- `violations_skipped`: Number of violations that couldn't be fixed (need manual review)

## Monitoring Data Quality

### Check for Issues
```sql
-- View all violations with issues
SELECT * FROM violations_with_issues;

-- Count issues by type
SELECT issue_type, COUNT(*) 
FROM violations_with_issues 
GROUP BY issue_type;
```

### Refresh Materialized View
For faster reporting, refresh the materialized view periodically:
```sql
REFRESH MATERIALIZED VIEW violations_by_exam_student;
```

## Impact on Application

After applying this migration:
1. **Admin Dashboard**: Will show separate entries for the same student in different exam sessions
2. **Student Violations View**: Will correctly filter violations by exam session
3. **Export Functionality**: Will export violations for the correct exam session only
4. **Photos/Evidence**: Will be linked to the correct exam session

## Backward Compatibility

- The migration is backward compatible with existing data
- The trigger will attempt to auto-fix missing links when possible
- Existing violations without `exam_id` will still work, but new violations should always include `exam_id`

## Important Notes

1. **Always include exam_id**: When creating new violations, always provide `exam_id` to ensure proper linking
2. **Run data fix migration**: After applying the main migration, run the data fix migration to clean up existing data
3. **Monitor the view**: Periodically check `violations_with_issues` to ensure data quality
4. **Refresh materialized view**: If using the materialized view, refresh it periodically for accurate reporting

## Troubleshooting

### If violations are still being mixed:
1. Check if `exam_id` is being set correctly when creating violations
2. Run the data fix migration: `20251120000001_fix_existing_violations_data.sql`
3. Check `violations_with_issues` view for remaining issues
4. Verify that the application code is passing `exam_id` when creating violations

### If trigger causes errors:
- The trigger will raise an exception if `exam_id` and `student_id` don't match
- This is intentional to prevent data inconsistencies
- Fix the data before inserting, or let the trigger auto-populate missing fields

## Future Improvements

Consider making `exam_id` NOT NULL after ensuring all existing violations have proper links:
```sql
ALTER TABLE public.violations 
ALTER COLUMN exam_id SET NOT NULL;
```

This should only be done after:
1. Running the data fix migration
2. Verifying no violations have NULL exam_id
3. Ensuring all application code sets exam_id when creating violations

