-- =====================================================
-- FIX VIOLATION SCHEMA FOR AUDIO VIOLATIONS
-- =====================================================
-- This script ensures audio_violation and all other violation types
-- are properly included in the database constraint

-- Step 1: Drop the old constraint FIRST (before adding new one)
ALTER TABLE public.violations
DROP CONSTRAINT IF EXISTS violations_violation_type_check;

-- Step 2: Update any violation types that don't match standard names
-- This handles any unexpected violation types in your database
UPDATE public.violations 
SET violation_type = 'object_detected' 
WHERE violation_type NOT IN (
  'gaze_away', 'looking_away', 'multiple_faces', 'multiple_person',
  'no_face', 'no_person', 'phone_detected', 'phone', 'object_detected', 
  'object', 'book_detected', 'tab_switch', 'copy_paste', 'audio_violation',
  'audio_noise', 'excessive_noise', 'eye_movement', 'shoulder_movement', 'window_blur'
);

-- Step 3: Add the new constraint with ALL possible violation types
ALTER TABLE public.violations
ADD CONSTRAINT violations_violation_type_check 
CHECK (violation_type IN (
  -- Standard violation types (used by backend)
  'looking_away',        -- Student looking away from screen
  'no_person',           -- No person detected in frame
  'phone_detected',      -- Mobile phone detected
  'book_detected',       -- Book detected
  'multiple_faces',      -- Multiple people detected
  'multiple_person',     -- Multiple people detected (alternative)
  'object_detected',     -- Prohibited object detected
  'tab_switch',         -- Browser tab switched
  'copy_paste',         -- Copy/paste detected
  'audio_violation',    -- Audio/sound violation (IMPORTANT: This must be included!)
  -- Alternative naming (for backward compatibility)
  'gaze_away',
  'no_face',
  'phone',
  'object',
  'audio_noise',
  'excessive_noise',
  -- New violation types
  'eye_movement',       -- Eye movement detected for extended period
  'shoulder_movement',  -- Continuous shoulder movement detected
  -- Additional types
  'window_blur'
));

-- Add comment for documentation
COMMENT ON COLUMN public.violations.violation_type IS 'Type of violation: looking_away, multiple_faces, no_person, phone_detected, object_detected, tab_switch, copy_paste, audio_violation, eye_movement, shoulder_movement';

-- Step 4: Ensure student_id column exists in students table
ALTER TABLE public.students
ADD COLUMN IF NOT EXISTS student_id TEXT;

-- Create index for faster lookups
CREATE INDEX IF NOT EXISTS idx_students_student_id ON public.students(student_id);

COMMENT ON COLUMN public.students.student_id IS 'Unique student identifier (e.g., roll number or email prefix)';

-- Step 5: Verify audio_violation records exist (for debugging)
-- Uncomment to check:
-- SELECT COUNT(*) as audio_violation_count 
-- FROM public.violations 
-- WHERE violation_type = 'audio_violation';

