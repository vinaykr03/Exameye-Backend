-- Add compatibility_checks table to store device + environment diagnostics before exam
CREATE TABLE IF NOT EXISTS public.compatibility_checks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id UUID REFERENCES public.students(id) ON DELETE CASCADE,
  exam_id UUID REFERENCES public.exams(id) ON DELETE CASCADE,
  screen_resolution TEXT,
  browser_info JSONB,
  internet_speed_mbps NUMERIC,
  screen_sharing_enabled BOOLEAN,
  audio_baseline NUMERIC,
  lighting_score NUMERIC,
  tab_token UUID,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Track active exam sessions to enforce single-tab policy
CREATE TABLE IF NOT EXISTS public.exam_active_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  exam_id UUID REFERENCES public.exams(id) ON DELETE CASCADE,
  student_id UUID REFERENCES public.students(id) ON DELETE CASCADE,
  session_token UUID NOT NULL,
  last_heartbeat TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_exam_active_sessions_exam_student
  ON public.exam_active_sessions(exam_id, student_id);

CREATE INDEX IF NOT EXISTS idx_exam_active_sessions_token
  ON public.exam_active_sessions(session_token);

-- Enable RLS and provide permissive policies similar to other demo tables
ALTER TABLE public.compatibility_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.exam_active_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can insert compatibility checks" ON public.compatibility_checks
  FOR INSERT WITH CHECK (true);
CREATE POLICY "Anyone can read compatibility checks" ON public.compatibility_checks
  FOR SELECT USING (true);

CREATE POLICY "Anyone can insert exam sessions" ON public.exam_active_sessions
  FOR INSERT WITH CHECK (true);
CREATE POLICY "Anyone can read exam sessions" ON public.exam_active_sessions
  FOR SELECT USING (true);
CREATE POLICY "Anyone can update exam sessions" ON public.exam_active_sessions
  FOR UPDATE USING (true);

