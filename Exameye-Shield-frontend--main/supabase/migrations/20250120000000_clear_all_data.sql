-- Migration: Clear All Data While Maintaining Schema
-- This script deletes all records from all tables AND all storage files
-- while preserving the table structure, constraints, indexes, relationships, and bucket structure.
-- 
-- WARNING: This will delete ALL data and ALL storage files. Use with caution!
-- 
-- To use this:
-- 1. Go to Supabase Dashboard → SQL Editor
-- 2. Copy and paste this entire script
-- 3. Run it
-- 
-- Or use Supabase CLI:
-- supabase migration new clear_all_data
-- (then copy this content to the new migration file)

-- Disable triggers temporarily to speed up deletion
SET session_replication_role = 'replica';

-- ============================================================================
-- STEP 1: Delete all storage files from buckets
-- ============================================================================
-- Delete files from violation-evidence bucket (violation images)
DELETE FROM storage.objects WHERE bucket_id = 'violation-evidence';

-- Delete files from face-registrations bucket (student face images)
DELETE FROM storage.objects WHERE bucket_id = 'face-registrations';

-- Delete files from PDF reports bucket
DELETE FROM storage.objects WHERE bucket_id = 'pdf-reports';

-- Delete files from subject-specific buckets
DELETE FROM storage.objects WHERE bucket_id IN (
  'data-structure-etcs214a',
  'engineering-mathematics-etcs332b',
  'operating-system-etcs456a',
  'theory-of-computation-etcs75a',
  'chemistry-etcs852a'
);

-- ============================================================================
-- STEP 2: Delete all database records
-- ============================================================================
-- Delete in order to respect foreign key constraints
-- Start with child tables (tables that reference other tables)

-- 1. Delete from exam_active_sessions (references exams and students)
DELETE FROM public.exam_active_sessions;

-- 2. Delete from compatibility_checks (references exams and students)
DELETE FROM public.compatibility_checks;

-- 3. Delete from violations (references exams and students)
DELETE FROM public.violations;

-- 4. Delete from exam_answers (references exams)
DELETE FROM public.exam_answers;

-- 5. Delete from exam_questions (references exam_templates)
DELETE FROM public.exam_questions;

-- 6. Delete from exams (references students)
DELETE FROM public.exams;

-- 7. Delete from students (no dependencies)
DELETE FROM public.students;

-- 8. Delete from exam_templates (no dependencies, but referenced by exam_questions)
DELETE FROM public.exam_templates;

-- Re-enable triggers
SET session_replication_role = 'origin';

-- ============================================================================
-- STEP 3: Verify deletion
-- ============================================================================
DO $$
DECLARE
  violations_count INTEGER;
  exams_count INTEGER;
  students_count INTEGER;
  exam_answers_count INTEGER;
  exam_questions_count INTEGER;
  exam_templates_count INTEGER;
  compatibility_checks_count INTEGER;
  exam_active_sessions_count INTEGER;
  violation_files_count INTEGER;
  face_files_count INTEGER;
  pdf_files_count INTEGER;
BEGIN
  -- Count database records
  SELECT COUNT(*) INTO violations_count FROM public.violations;
  SELECT COUNT(*) INTO exams_count FROM public.exams;
  SELECT COUNT(*) INTO students_count FROM public.students;
  SELECT COUNT(*) INTO exam_answers_count FROM public.exam_answers;
  SELECT COUNT(*) INTO exam_questions_count FROM public.exam_questions;
  SELECT COUNT(*) INTO exam_templates_count FROM public.exam_templates;
  SELECT COUNT(*) INTO compatibility_checks_count FROM public.compatibility_checks;
  SELECT COUNT(*) INTO exam_active_sessions_count FROM public.exam_active_sessions;
  
  -- Count storage files
  SELECT COUNT(*) INTO violation_files_count FROM storage.objects WHERE bucket_id = 'violation-evidence';
  SELECT COUNT(*) INTO face_files_count FROM storage.objects WHERE bucket_id = 'face-registrations';
  SELECT COUNT(*) INTO pdf_files_count FROM storage.objects WHERE bucket_id = 'pdf-reports';
  
  -- Display results
  RAISE NOTICE '✅ Data deletion completed!';
  RAISE NOTICE '';
  RAISE NOTICE '📊 Database Records:';
  RAISE NOTICE '  - Violations: %', violations_count;
  RAISE NOTICE '  - Exams: %', exams_count;
  RAISE NOTICE '  - Students: %', students_count;
  RAISE NOTICE '  - Exam Answers: %', exam_answers_count;
  RAISE NOTICE '  - Exam Questions: %', exam_questions_count;
  RAISE NOTICE '  - Exam Templates: %', exam_templates_count;
  RAISE NOTICE '  - Compatibility Checks: %', compatibility_checks_count;
  RAISE NOTICE '  - Active Sessions: %', exam_active_sessions_count;
  RAISE NOTICE '';
  RAISE NOTICE '📁 Storage Files:';
  RAISE NOTICE '  - Violation Evidence: % files', violation_files_count;
  RAISE NOTICE '  - Face Registrations: % files', face_files_count;
  RAISE NOTICE '  - PDF Reports: % files', pdf_files_count;
  RAISE NOTICE '';
  RAISE NOTICE '✅ Schema, constraints, indexes, relationships, and bucket structure are preserved.';
  RAISE NOTICE '✅ All storage buckets remain intact and ready to use.';
END $$;

