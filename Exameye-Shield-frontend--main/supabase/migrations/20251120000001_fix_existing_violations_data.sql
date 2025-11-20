-- Optional migration: Fix existing violations data
-- Run this AFTER applying the main migration to fix existing data inconsistencies
-- This is safe to run multiple times

-- Step 1: Fix violations with missing exam_id (but have student_id)
-- This will link violations to the most appropriate exam session
DO $$
DECLARE
  fixed_count INTEGER;
BEGIN
  -- Update violations that have student_id but no exam_id
  UPDATE public.violations v
  SET exam_id = (
    SELECT e.id
    FROM public.exams e
    WHERE e.student_id = v.student_id
    AND (
      -- Prefer exams that were active around the violation time
      (v.timestamp >= e.started_at AND v.timestamp <= COALESCE(e.completed_at, NOW()))
      OR
      -- Fallback to most recent exam if timestamp doesn't match
      (e.started_at IS NULL AND e.id = (
        SELECT id FROM public.exams 
        WHERE student_id = v.student_id 
        ORDER BY created_at DESC LIMIT 1
      ))
    )
    ORDER BY 
      CASE 
        WHEN v.timestamp >= e.started_at AND v.timestamp <= COALESCE(e.completed_at, NOW()) 
        THEN 1 
        ELSE 2 
      END,
      e.started_at DESC NULLS LAST
    LIMIT 1
  )
  WHERE v.exam_id IS NULL 
  AND v.student_id IS NOT NULL;
  
  GET DIAGNOSTICS fixed_count = ROW_COUNT;
  RAISE NOTICE 'Fixed % violations with missing exam_id', fixed_count;
END $$;

-- Step 2: Fix violations where exam_id and student_id don't match
-- This will update student_id to match the exam
DO $$
DECLARE
  fixed_count INTEGER;
BEGIN
  UPDATE public.violations v
  SET student_id = (
    SELECT e.student_id 
    FROM public.exams e 
    WHERE e.id = v.exam_id
  )
  WHERE v.exam_id IS NOT NULL
  AND v.student_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.exams e
    WHERE e.id = v.exam_id
    AND e.student_id = v.student_id
  );
  
  GET DIAGNOSTICS fixed_count = ROW_COUNT;
  RAISE NOTICE 'Fixed % violations with mismatched exam_id and student_id', fixed_count;
END $$;

-- Step 3: Update violations that have exam_id but missing student_id
DO $$
DECLARE
  fixed_count INTEGER;
BEGIN
  UPDATE public.violations v
  SET student_id = (
    SELECT e.student_id 
    FROM public.exams e 
    WHERE e.id = v.exam_id
  )
  WHERE v.exam_id IS NOT NULL
  AND v.student_id IS NULL;
  
  GET DIAGNOSTICS fixed_count = ROW_COUNT;
  RAISE NOTICE 'Fixed % violations with missing student_id', fixed_count;
END $$;

-- Step 4: Refresh the materialized view if it exists
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_matviews WHERE matviewname = 'violations_by_exam_student'
  ) THEN
    EXECUTE 'REFRESH MATERIALIZED VIEW violations_by_exam_student';
  END IF;
END $$;

-- Summary: Show remaining issues (if any)
DO $$
DECLARE
  remaining_issues INTEGER;
  view_exists BOOLEAN;
BEGIN
  -- Check if the violations_with_issues view exists
  SELECT EXISTS (
    SELECT 1 
    FROM information_schema.views 
    WHERE table_schema = 'public' 
    AND table_name = 'violations_with_issues'
  ) INTO view_exists;
  
  IF view_exists THEN
    SELECT COUNT(*) INTO remaining_issues
    FROM violations_with_issues;
    
    IF remaining_issues > 0 THEN
      RAISE NOTICE 'Warning: % violations still have issues. Check violations_with_issues view for details.', remaining_issues;
    ELSE
      RAISE NOTICE 'All violations have been fixed!';
    END IF;
  ELSE
    RAISE NOTICE 'Note: violations_with_issues view does not exist. Please run the main migration first (20251120000000_fix_violations_exam_student_consistency.sql)';
  END IF;
END $$;

