# Roll Number Implementation Summary

## Overview
This document summarizes the changes made to implement roll number (`roll_no`) support throughout the application, replacing the use of randomly generated student IDs for file organization and display.

## Database Changes

### Migration: `20250121000000_add_roll_no_to_students.sql`
- Added `roll_no` column to `students` table (TEXT, NOT NULL, UNIQUE)
- Added `roll_no` column to `exam_active_sessions` table
- Created indexes for faster roll_no lookups
- Backfilled existing students with temporary roll numbers

## Frontend Changes

### 1. Student Registration (`StudentRegister.tsx`)
- Added `rollNo` field to registration form
- Updated form validation to require roll number
- Updated database insert to include `roll_no`
- Updated face image upload to use `roll_no` for file organization (instead of `student_id`)
- Updated session storage to include `rollNo`

### 2. Student Exam (`StudentExam.tsx`)
- Updated WebSocket hook to pass `rollNo` to backend
- Updated session storage to include `rollNo` in student data

### 3. WebSocket Hook (`useProctoringWebSocket.ts`)
- Added `rollNo` parameter to interface
- Updated all WebSocket payloads (frame, audio, browser_activity) to include `roll_no`
- Backend receives `roll_no` for violation file organization

### 4. Admin Dashboard (`AdminDashboard.tsx`)
- Updated database queries to fetch `roll_no` from students table
- Updated student grouping logic to extract `roll_no` from violation details
- Updated UI to display "Roll No: {roll_no}" instead of just student_id
- Updated `buildCompletedStudents` to include `roll_no` in `studentIdentifier`

### 5. Student Report (`StudentReport.tsx`)
- Updated database queries to fetch `roll_no` from students table
- Updated UI to display "Roll Number" instead of "Student ID"
- Updated student data interface to include `roll_no` field
- Updated fallback logic to use `roll_no` when available

## Backend Changes

### 1. Violation File Upload (`server.py`)
- Updated `_upload_snapshot_and_get_url()` function:
  - Changed parameter from `student_id` to `roll_no`
  - Updated file path format: `{exam_id}/{roll_no}_{violation_type}_{timestamp}.jpg`
- Updated WebSocket message handling to extract `roll_no` from message
- Updated violation record creation to include `roll_no` in `details` JSONB field
- Updated `/api/upload-violation-snapshot` endpoint to accept `roll_no` parameter

## File Organization

### Storage Bucket Structure
**Before:**
```
violation-evidence/
  {exam_id}/
    {student_id}_{violation_type}_{timestamp}.jpg
```

**After:**
```
violation-evidence/
  {exam_id}/
    {roll_no}_{violation_type}_{timestamp}.jpg
```

**Face Registrations:**
```
face-registrations/
  {roll_no}/
    {student_name}_{timestamp}.jpg
```

## Benefits

1. **Human-Readable Organization**: Files are now organized by roll number, making it easier to locate violation evidence for specific students
2. **Better User Experience**: Roll numbers are displayed in Admin Dashboard and Student Reports instead of UUIDs
3. **Consistent Identification**: Roll number is used consistently across registration, file storage, and reporting
4. **Backward Compatibility**: System still supports `student_id` (UUID) for internal linking, but uses `roll_no` for display and file organization

## Migration Steps

1. Run the migration: `supabase migration up` or execute `20250121000000_add_roll_no_to_students.sql` in Supabase SQL Editor
2. Existing students will be assigned temporary roll numbers (format: `ROLL-{first8chars}`)
3. New registrations will require roll number input
4. Violation files will be organized by roll number going forward

## Notes

- Roll numbers are stored in uppercase for consistency
- Roll numbers must be unique across all students
- The system falls back to `student_id` if `roll_no` is not available (for backward compatibility)
- Violation details JSONB field includes `roll_no` for easy querying and filtering

