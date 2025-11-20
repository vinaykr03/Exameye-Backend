-- Migration: Fix violations table to ensure exam_id and student_id consistency
-- This prevents mixing violations from different exam sessions for the same student

-- Step 1: Add composite indexes for better query performance
-- Index for querying violations by exam_id and student_id together
CREATE INDEX IF NOT EXISTS idx_violations_exam_student 
ON public.violations(exam_id, student_id) 
WHERE exam_id IS NOT NULL AND student_id IS NOT NULL;

-- Index for querying violations by student_id and exam_id (reverse lookup)
CREATE INDEX IF NOT EXISTS idx_violations_student_exam 
ON public.violations(student_id, exam_id) 
WHERE exam_id IS NOT NULL AND student_id IS NOT NULL;

-- Index for querying violations by exam_id and timestamp (for exam-specific queries)
CREATE INDEX IF NOT EXISTS idx_violations_exam_timestamp 
ON public.violations(exam_id, timestamp DESC) 
WHERE exam_id IS NOT NULL;

-- Step 2: Create a function to validate exam_id and student_id consistency
-- This ensures that if both exam_id and student_id are present, they must match
CREATE OR REPLACE FUNCTION validate_violation_exam_student_consistency()
RETURNS TRIGGER AS $$
BEGIN
  -- If both exam_id and student_id are provided, ensure they match
  IF NEW.exam_id IS NOT NULL AND NEW.student_id IS NOT NULL THEN
    -- Check if the student_id in the violation matches the student_id of the exam
    IF NOT EXISTS (
      SELECT 1 
      FROM public.exams 
      WHERE id = NEW.exam_id 
      AND student_id = NEW.student_id
    ) THEN
      RAISE EXCEPTION 'Violation student_id (%) does not match the student_id of exam (%)', 
        NEW.student_id, NEW.exam_id;
    END IF;
  END IF;
  
  -- If exam_id is provided but student_id is not, try to populate student_id from exam
  IF NEW.exam_id IS NOT NULL AND NEW.student_id IS NULL THEN
    SELECT student_id INTO NEW.student_id
    FROM public.exams
    WHERE id = NEW.exam_id;
  END IF;
  
  -- If student_id is provided but exam_id is not, try to find the most recent exam for this student
  -- This helps with backward compatibility but should be avoided in new code
  IF NEW.exam_id IS NULL AND NEW.student_id IS NOT NULL THEN
    -- Try to find the most recent active or completed exam for this student
    SELECT id INTO NEW.exam_id
    FROM public.exams
    WHERE student_id = NEW.student_id
    AND status IN ('in_progress', 'completed')
    ORDER BY started_at DESC NULLS LAST, created_at DESC
    LIMIT 1;
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Step 3: Create trigger to enforce consistency before insert/update
DROP TRIGGER IF EXISTS trigger_validate_violation_exam_student ON public.violations;
CREATE TRIGGER trigger_validate_violation_exam_student
  BEFORE INSERT OR UPDATE ON public.violations
  FOR EACH ROW
  EXECUTE FUNCTION validate_violation_exam_student_consistency();

-- Step 4: Add a check constraint to ensure exam_id is not null for new violations
-- Note: We make this a soft constraint (warning) rather than hard constraint to avoid breaking existing data
-- For production, you may want to make exam_id NOT NULL after data cleanup
COMMENT ON COLUMN public.violations.exam_id IS 
  'REQUIRED: Links violation to specific exam session. Must match student_id if both are provided.';

COMMENT ON COLUMN public.violations.student_id IS 
  'Links violation to student. Should match the student_id of the exam if exam_id is provided.';

-- Step 5: Create a function to help fix existing violations with missing or inconsistent exam_id
-- This can be run manually to fix data issues
CREATE OR REPLACE FUNCTION fix_violations_exam_links()
RETURNS TABLE(
  violations_fixed INTEGER,
  violations_skipped INTEGER
) AS $$
DECLARE
  v_fixed INTEGER := 0;
  v_skipped INTEGER := 0;
  v_record RECORD;
BEGIN
  -- Fix violations that have student_id but no exam_id
  FOR v_record IN 
    SELECT v.id, v.student_id, v.timestamp
    FROM public.violations v
    WHERE v.exam_id IS NULL 
    AND v.student_id IS NOT NULL
    ORDER BY v.timestamp DESC
  LOOP
    -- Try to find the most appropriate exam for this violation
    UPDATE public.violations
    SET exam_id = (
      SELECT e.id
      FROM public.exams e
      WHERE e.student_id = v_record.student_id
      AND (
        -- Prefer exams that were active around the violation time
        (v_record.timestamp >= e.started_at AND v_record.timestamp <= COALESCE(e.completed_at, NOW()))
        OR
        -- Fallback to most recent exam if timestamp doesn't match
        (e.started_at IS NULL AND e.id = (
          SELECT id FROM public.exams 
          WHERE student_id = v_record.student_id 
          ORDER BY created_at DESC LIMIT 1
        ))
      )
      ORDER BY 
        CASE 
          WHEN v_record.timestamp >= e.started_at AND v_record.timestamp <= COALESCE(e.completed_at, NOW()) 
          THEN 1 
          ELSE 2 
        END,
        e.started_at DESC NULLS LAST
      LIMIT 1
    )
    WHERE id = v_record.id
    AND exam_id IS NULL;
    
    IF FOUND THEN
      v_fixed := v_fixed + 1;
    ELSE
      v_skipped := v_skipped + 1;
    END IF;
  END LOOP;
  
  -- Fix violations that have exam_id but student_id doesn't match
  FOR v_record IN
    SELECT v.id, v.exam_id, v.student_id
    FROM public.violations v
    WHERE v.exam_id IS NOT NULL
    AND v.student_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.exams e
      WHERE e.id = v.exam_id
      AND e.student_id = v.student_id
    )
  LOOP
    -- Update student_id to match the exam
    UPDATE public.violations
    SET student_id = (
      SELECT student_id FROM public.exams WHERE id = v_record.exam_id
    )
    WHERE id = v_record.id;
    
    IF FOUND THEN
      v_fixed := v_fixed + 1;
    END IF;
  END LOOP;
  
  RETURN QUERY SELECT v_fixed, v_skipped;
END;
$$ LANGUAGE plpgsql;

-- Step 6: Add a view to help identify violations with missing or inconsistent exam links
CREATE OR REPLACE VIEW violations_with_issues AS
SELECT 
  v.id,
  v.exam_id,
  v.student_id,
  v.violation_type,
  v.timestamp,
  v.details->>'student_name' as student_name,
  v.details->>'subject_code' as subject_code,
  CASE 
    WHEN v.exam_id IS NULL THEN 'Missing exam_id'
    WHEN v.student_id IS NULL THEN 'Missing student_id'
    WHEN NOT EXISTS (
      SELECT 1 FROM public.exams e
      WHERE e.id = v.exam_id AND e.student_id = v.student_id
    ) THEN 'exam_id and student_id mismatch'
    ELSE 'OK'
  END as issue_type,
  e.subject_code as exam_subject_code,
  e.students.name as exam_student_name
FROM public.violations v
LEFT JOIN public.exams e ON v.exam_id = e.id
LEFT JOIN public.students ON e.student_id = students.id
WHERE 
  v.exam_id IS NULL 
  OR v.student_id IS NULL
  OR NOT EXISTS (
    SELECT 1 FROM public.exams e2
    WHERE e2.id = v.exam_id AND e2.student_id = v.student_id
  );

COMMENT ON VIEW violations_with_issues IS 
  'Identifies violations with missing exam_id, missing student_id, or mismatched exam_id/student_id pairs';

-- Step 7: Create a materialized view for faster reporting (optional, can be refreshed periodically)
CREATE MATERIALIZED VIEW IF NOT EXISTS violations_by_exam_student AS
SELECT 
  e.id as exam_id,
  e.student_id,
  s.name as student_name,
  s.student_id as student_identifier,
  COALESCE(et.subject_code, e.subject_code) as subject_code,
  et.subject_name,
  COUNT(v.id) as violation_count,
  ARRAY_AGG(DISTINCT v.violation_type) FILTER (WHERE v.violation_type IS NOT NULL) as violation_types,
  MIN(v.timestamp) as first_violation,
  MAX(v.timestamp) as last_violation
FROM public.exams e
INNER JOIN public.students s ON e.student_id = s.id
LEFT JOIN public.exam_templates et ON e.exam_template_id = et.id
LEFT JOIN public.violations v ON v.exam_id = e.id AND v.student_id = e.student_id
GROUP BY e.id, e.student_id, s.name, s.student_id, e.subject_code, et.subject_code, et.subject_name;

CREATE UNIQUE INDEX IF NOT EXISTS idx_violations_by_exam_student_exam_id 
ON violations_by_exam_student(exam_id);

COMMENT ON MATERIALIZED VIEW violations_by_exam_student IS 
  'Pre-aggregated view of violations grouped by exam and student. Refresh with: REFRESH MATERIALIZED VIEW violations_by_exam_student;';

-- Step 8: Add helpful comments
COMMENT ON TABLE public.violations IS 
  'Stores exam violations. CRITICAL: exam_id should always be set to link violations to specific exam sessions. 
   This prevents mixing violations from different exam sessions for the same student.';

