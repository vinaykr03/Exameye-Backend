-- Migration: Add roll_no field to students table
-- This adds a roll number field that will be used for student identification
-- and for organizing violation evidence files in storage buckets

-- Step 1: Add roll_no column to students table
ALTER TABLE public.students
ADD COLUMN IF NOT EXISTS roll_no TEXT;

-- Step 2: Make roll_no unique and not null (after backfilling existing data)
-- First, backfill existing students with a temporary roll_no based on their id
UPDATE public.students
SET roll_no = 'ROLL-' || SUBSTRING(id::TEXT, 1, 8)
WHERE roll_no IS NULL;

-- Step 3: Add unique constraint and make it required
ALTER TABLE public.students
ALTER COLUMN roll_no SET NOT NULL;

-- Add unique constraint
CREATE UNIQUE INDEX IF NOT EXISTS idx_students_roll_no ON public.students(roll_no);

-- Step 4: Add roll_no to violations details for easier lookup
-- This is already in JSONB details field, but we can add it as a direct field for better querying
-- Note: We'll keep it in details for backward compatibility, but also add a computed index

-- Step 5: Create index on violations.details->>roll_no for faster lookups
-- Use btree index on the extracted text value instead of GIN (GIN requires operator class for text)
CREATE INDEX IF NOT EXISTS idx_violations_details_roll_no 
ON public.violations ((details->>'roll_no'));

-- Step 6: Add roll_no to exam_active_sessions for better tracking
ALTER TABLE public.exam_active_sessions
ADD COLUMN IF NOT EXISTS roll_no TEXT;

-- Create index for faster lookups by roll_no
CREATE INDEX IF NOT EXISTS idx_exam_active_sessions_roll_no ON public.exam_active_sessions(roll_no);

-- Step 7: Update the generate_subject_code function to also generate roll_no if needed
-- (This is optional, as roll_no should be provided during registration)

-- Success message
DO $$
BEGIN
  RAISE NOTICE '✅ Migration completed: roll_no field added to students table';
  RAISE NOTICE '📋 Changes:';
  RAISE NOTICE '  - Added roll_no column to students (unique, required)';
  RAISE NOTICE '  - Added roll_no column to exam_active_sessions';
  RAISE NOTICE '  - Created indexes for faster roll_no lookups';
  RAISE NOTICE '  - Existing students have been assigned temporary roll numbers';
END $$;

