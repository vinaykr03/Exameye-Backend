-- Fix security issue: Set fixed search_path for get_primary_exam_id function
-- This prevents SQL injection attacks that could exploit a mutable search_path
-- 
-- Security Note: Functions with mutable search_path are vulnerable to SQL injection
-- attacks. Setting a fixed search_path ensures that the function always uses the
-- intended schema, preventing attackers from manipulating the search path.

-- Use ALTER FUNCTION to set search_path for all variants of the function
-- This approach preserves the function definition while fixing the security issue

DO $$
DECLARE
    func_record RECORD;
    func_signature TEXT;
BEGIN
    -- Find all variants of get_primary_exam_id function
    FOR func_record IN
        SELECT 
            p.oid,
            p.proname,
            pg_get_function_identity_arguments(p.oid) as args,
            n.nspname
        FROM pg_proc p
        JOIN pg_namespace n ON p.pronamespace = n.oid
        WHERE n.nspname = 'public' 
        AND p.proname = 'get_primary_exam_id'
    LOOP
        -- Build the function signature
        func_signature := 'public.get_primary_exam_id(' || func_record.args || ')';
        
        BEGIN
            -- Set search_path to 'public' (or empty string for maximum security)
            -- Using empty string is more secure but may require fully qualified names
            EXECUTE format('ALTER FUNCTION %s SET search_path = ''public''', func_signature);
            
            RAISE NOTICE 'Successfully set search_path for function: %', func_signature;
        EXCEPTION 
            WHEN OTHERS THEN
                RAISE WARNING 'Could not alter function %: %', func_signature, SQLERRM;
        END;
    END LOOP;
    
    -- If no functions were found, log a notice
    IF NOT FOUND THEN
        RAISE NOTICE 'Function get_primary_exam_id not found. If it exists with different parameters, you may need to fix it manually.';
    END IF;
END $$;

-- Verify the fix by checking the function's search_path setting
-- This query will show the current search_path for the function
DO $$
DECLARE
    func_oid OID;
    search_path_setting TEXT;
BEGIN
    SELECT p.oid INTO func_oid
    FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'public' 
    AND p.proname = 'get_primary_exam_id'
    LIMIT 1;
    
    IF func_oid IS NOT NULL THEN
        -- Get the search_path setting from pg_proc.proconfig
        SELECT COALESCE(
            (SELECT setting FROM unnest(pg_proc.proconfig) AS setting WHERE setting LIKE 'search_path=%'),
            'search_path not set (uses default)'
        ) INTO search_path_setting
        FROM pg_proc
        WHERE oid = func_oid;
        
        RAISE NOTICE 'Function search_path setting: %', search_path_setting;
    END IF;
END $$;

