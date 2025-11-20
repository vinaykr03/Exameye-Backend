-- Add student_name column to violations table for better reporting
ALTER TABLE public.violations 
ADD COLUMN IF NOT EXISTS student_name TEXT;

-- Update existing violations with student_name from details if available
UPDATE public.violations 
SET student_name = details->>'student_name' 
WHERE student_name IS NULL AND details->>'student_name' IS NOT NULL;